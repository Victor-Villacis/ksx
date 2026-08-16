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
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  { path: "/start", name: "start" },
  { path: "/workspace", name: "workspace" },
  { path: "/", name: "status" },
  { path: "/map", name: "map" },
  { path: "/check", name: "check" },
  { path: "/pads", name: "pads" },
  { path: "/devices", name: "devices" },
  { path: "/profiles", name: "profiles" },
  { path: "/setup", name: "setup" },
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
    const up = await fetch(`${BASE}/api/map`).then(
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
    assert.equal(records.length, expectedCount, "the screenshot artifact is incomplete");
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
            return {
              status: document.querySelector("[data-forma-island]")?.dataset.formaStatus ?? null,
              viewportWidth,
              documentWidth,
              coarse: matchMedia("(pointer: coarse)").matches,
              light: matchMedia("(prefers-color-scheme: light)").matches,
              containers,
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
            `${config.name} did not expose the intended colour scheme`,
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
