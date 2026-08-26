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
          // ⚠️ WHAT THIS PINS IS NO LONGER WHAT IT SAYS IT PINS.
          //
          // The rationale here used to be "the design-proof route deliberately
          // ignores themes… and dies wholesale at M5 (its own banner's
          // contract)". That route is now THE PRODUCT — `/nocturne` is the
          // only page ksx Studio ships — and the frame still hard-codes its
          // palette: `studio.css` sets `--n-bg: #161826` on `.nocturne` and
          // paints `background: var(--n-bg)` on a `height: 100vh;
          // overflow: hidden` frame. The theme stamp reaches `body` and
          // nothing else, so the frame covers every pixel of the ground the
          // assertion above just proved was themed.
          //
          // The consequence is a shipped theme picker (`/nocturne/theme`,
          // `themes.json` = dark/light/matrix) that changes NOTHING A USER CAN
          // SEE on the product page — and this assertion is what would fail
          // first if somebody fixed it. It is left standing on purpose: the
          // fact it states is true today, and deleting it would let the frame
          // drift silently while the question is decided. But it is a
          // REGRESSION GUARD OVER A DEFECT, not a contract, and whoever owns
          // the token system should either theme `--n-bg` (and re-point this
          // at `theme.bg`) or remove the picker.
          assert.equal(
            painted.nocturneStage,
            "rgb(22, 24, 38)",
            `${route.path}'s .nocturne frame still hard-codes --n-bg under stamped ${theme.id} ` +
              `— if this failed because the frame learned the theme, that is the fix landing: ` +
              `re-point this at hexToRgb(theme.bg)`,
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
