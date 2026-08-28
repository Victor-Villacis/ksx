// The redesign device workbench, in a real browser.
//
// WHY THIS LEVEL: the Rust tests pin that the picker is SERVED (four tiers,
// the nocturne sorting rules, the raw selector on every row — render_redesign
// and snapshot.rs). Only a browser can pin the workbench itself: that picking
// boards mounts widgets on the canvas — several at once, the lane's whole
// thesis — that membership survives a reload through the arrangement store,
// that removal is a toggle away, and that the unavailable tier is visible but
// never a control.
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
const PORT = Number(process.env.KSX_PWTEST_REDESIGN_DEVICES_PORT ?? 4531);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

// The fixture's roster, by RAW selector (macro_fixture.rs device_scan).
const IPAC = "usb:d209:0430:00";
const G915 = "usb:046d:c545:00";
const IPAC_SLUG = "dev-usb-d209-0430-00";
const G915_SLUG = "dev-usb-046d-c545-00";

let server;
let browser;
/** ONE context for the whole suite — the workbench remembers through
 *  localStorage, and a fresh context per test would silently test nothing. */
let context;

async function waitForServer(base = BASE, deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/redesign`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${base}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio devices fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer(BASE);
  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });
});

after(async () => {
  try {
    await context?.close();
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopFixtureProcess(server, "devices fixture");
    }
  }
});

/** A hydrated /redesign whose canvas has adopted. The workbench starts
 *  empty, so the engine's first camera transform is the adoption mark —
 *  restoreBench runs in the same init, so any remembered boards are mounted
 *  by the time the transform lands. */
async function openBench() {
  const page = await context.newPage();
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
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
  return page;
}

describe("the device workbench", () => {
  test("the picker serves every tier; picking two boards benches two widgets", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the modal opens",
    );
    // All four folds, with the fixture's counts — and the scan's own line.
    for (const head of [
      "Keyboards · 1",
      "Panel encoders · 1",
      "Not keyboards — experimental · 1",
      "Unavailable devices · 1",
    ]) {
      assert.ok(
        await page.locator(".rd-devmodal .rd-devhead", { hasText: head }).count(),
        `fold head ${head} is painted`,
      );
    }
    assert.match(
      (await page.locator(".rd-devmodal .n-devnote").textContent()) ?? "",
      /keyboard-capable/,
      "the scan line speaks",
    );
    // The unavailable tier is visible but NEVER a control.
    assert.equal(
      await page.locator(".rd-devmodal .n-dev.off").count(),
      1,
      "the unpickable board is shown",
    );
    assert.equal(
      await page.locator('.rd-devmodal button[data-selector=""], .rd-devmodal .n-dev.off button')
        .count(),
      0,
      "no button hides in the unavailable tier",
    );
    // Pick BOTH the keyboard and the encoder. The modal stays open — the
    // multi-add is the point.
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.click(`.rd-devmodal button[data-selector="${IPAC}"]`);
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the modal stays open for more picks",
    );
    for (const slug of [G915_SLUG, IPAC_SLUG]) {
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .canvasX !== undefined,
        slug,
        { timeout: 10_000 },
      );
    }
    // The widgets carry the RAW selector, and the rows now say so.
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"][data-selector="${IPAC}"]`)
        .count(),
      1,
      "the widget keeps the raw selector",
    );
    assert.equal(
      await page
        .locator(`.rd-devmodal button[data-selector="${IPAC}"][aria-pressed="true"]`)
        .count(),
      1,
      "the encoder row is pressed",
    );
    assert.match(
      (await page.locator(`.rd-devmodal button[data-selector="${G915}"] .rd-dev-word`).textContent()) ?? "",
      /On the workbench/,
      "the row says where the board went",
    );
    // Escape is the picker's rung on the ladder.
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      1,
      "Escape closes the picker first",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the workbench survives a reload — the arrangement store remembers", async () => {
    const page = await openBench();
    for (const slug of [G915_SLUG, IPAC_SLUG]) {
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .canvasX !== undefined,
        slug,
        { timeout: 10_000 },
      );
    }
    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      await page.locator('.rd-devmodal button[aria-pressed="true"]').count(),
      2,
      "both rows still marked after the reload",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("removal is the same toggle, and the removal also survives a reload", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.waitForFunction(
      (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.rd-devmodal button[data-selector="${G915}"][aria-pressed="false"]`)
        .count(),
      1,
      "the row un-pressed",
    );
    await page.close();

    const again = await openBench();
    assert.equal(
      await again.evaluate(
        (id) => Boolean(document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)),
        G915_SLUG,
      ),
      false,
      "the removed board stays off the bench",
    );
    await again.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .canvasX !== undefined,
      IPAC_SLUG,
      { timeout: 10_000 },
    );
    assert.deepEqual(again.ksxNoise, [], "the page must stay error-free");
    await again.close();
  });

  test("staging from the bench card runs the daemon verb; the marking follows the truth", async () => {
    const page = await openBench();
    // The seeded fixture stages its I-PAC from the START — the served
    // daemon fact must arrive on the benched card without any press, chip
    // on, verb withdrawn. (The stage-scoped selector matters: the minimap
    // marker wears the same data-instance-id.)
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .staged === "true",
      IPAC_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"] .rd-stageform`)
        .evaluate((form) => getComputedStyle(form).display),
      "none",
      "a staged card offers the chip, not the verb",
    );
    // Bench the keyboard again and promote IT: the verb runs through the
    // preparation-preserving guard, the flash speaks, and the marking MOVES
    // — off the encoder, onto the keyboard, on cards and rows alike.
    await page.click('[data-nx="rd-devs-open"]');
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .canvasX !== undefined,
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`)
        .getAttribute("data-staged"),
      "false",
      "an unstaged board's card offers the verb",
    );
    await page.click(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"] .rd-stagebtn`);
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .staged === "true",
      G915_SLUG,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".rd-flash")?.textContent ===
          "Keyboard selected. Nothing has been saved or started.",
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      (id) =>
        document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
          .staged === "false",
      IPAC_SLUG,
      { timeout: 10_000 },
    );
    await page.click('[data-nx="rd-devs-open"]');
    assert.equal(
      await page
        .locator(`.rd-devmodal button[data-selector="${G915}"][aria-current="true"]`)
        .count(),
      1,
      "the picker row carries the staged fact",
    );
    assert.equal(
      await page.locator('.rd-devmodal button[aria-current="true"]').count(),
      1,
      "exactly one row is the staged one",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});
