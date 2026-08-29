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
import {
  claimSavedDeviceGeometryKey,
  deviceInstanceId,
  legacyDeviceInstanceId,
} from "../src/device-instance-id.ts";

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
const IPAC_SLUG = deviceInstanceId(IPAC);
const G915_SLUG = deviceInstanceId(G915);

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
  test("the complete raw selector owns a collision-resistant canvas identity", () => {
    const punctuationTwinA = "opaque:panel/a";
    const punctuationTwinB = "opaque:panel:a";
    const longSharedPrefix = `usb:${"a".repeat(120)}`;
    const longTwinA = `${longSharedPrefix}:port=1`;
    const longTwinB = `${longSharedPrefix}:port=2`;

    for (const [left, right] of [
      [punctuationTwinA, punctuationTwinB],
      [longTwinA, longTwinB],
    ]) {
      assert.equal(
        legacyDeviceInstanceId(left),
        legacyDeviceInstanceId(right),
        "the fixture pair must reproduce the old lossy-key collision",
      );
      assert.notEqual(
        deviceInstanceId(left),
        deviceInstanceId(right),
        "the complete selector must distinguish twin boards",
      );
      for (const id of [deviceInstanceId(left), deviceInstanceId(right)]) {
        assert.match(id, /^[A-Za-z0-9_-]+$/, "the engine-safe charset is preserved");
        assert.ok(id.length <= 96, `canvas identity is ${id.length} characters`);
      }
    }
    assert.equal(
      deviceInstanceId(IPAC),
      "dev-usb-d209-0430-00-01xwu04m1az45",
      "the persisted identity for a known selector stays stable",
    );

    const legacyKey = legacyDeviceInstanceId(punctuationTwinA);
    const savedKeys = new Set([legacyKey]);
    const owners = new Map();
    assert.equal(
      claimSavedDeviceGeometryKey(punctuationTwinA, savedKeys, owners),
      legacyKey,
      "the first raw selector claims its migrated coordinates",
    );
    assert.equal(
      claimSavedDeviceGeometryKey(punctuationTwinB, savedKeys, owners),
      undefined,
      "a colliding twin falls back to its staggered home instead of stacking",
    );
    assert.equal(
      claimSavedDeviceGeometryKey(punctuationTwinA, savedKeys, owners),
      legacyKey,
      "the same board can reclaim its position after a remove/add cycle",
    );
  });

  test("the picker serves every tier; picking two boards benches two widgets", async () => {
    const page = await openBench();
    const opener = page.locator('[data-nx="rd-devs-open"]');
    await opener.click();
    assert.equal(
      await page.locator(".rd-devmodal[hidden]").count(),
      0,
      "the modal opens",
    );
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.matches('.rd-devmodal button[data-nx="rd-devs-close"]')
      ),
      true,
      "the picker lands on its first reliable control",
    );
    // The modal owns keyboard focus in both directions.
    const modalControls = page.locator(".rd-devmodal-panel button:not([disabled])");
    await modalControls.last().focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.matches('.rd-devmodal button[data-nx="rd-devs-close"]')
      ),
      true,
      "Tab wraps from the last control to the first",
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement === document.querySelectorAll(
        ".rd-devmodal-panel button:not([disabled])",
      ).item(document.querySelectorAll(".rd-devmodal-panel button:not([disabled])").length - 1)),
      true,
      "Shift+Tab wraps from the first control to the last",
    );
    // Ctrl+K transfers ownership instead of stacking two modal surfaces. Its
    // Escape return lands on the original Devices opener.
    await page.keyboard.press("Control+k");
    assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 1, "palette closes Devices");
    assert.equal(await page.locator(".rd-palette[hidden]").count(), 0, "palette opens alone");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".rd-palette-input")),
      true,
      "the palette owns focus",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rd-palette[hidden]").count(), 1, "Escape closes the palette");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-devs-open"]')),
      true,
      "closing the replacement overlay returns to the Devices opener",
    );
    await opener.click();
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
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-devs-open"]')),
      true,
      "closing the picker restores its opener",
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

  test("selected picker removal clears the Inspector and survives a reload", async () => {
    const page = await openBench();
    await page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`).click();
    await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === false);
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
    assert.equal(
      await page.locator(".rd-inspector[hidden]").count(),
      1,
      "removing the selected board closes its Inspector behind the picker",
    );
    assert.equal(
      await page.locator(".rd.is-inspector-open").count(),
      0,
      "the removed selection releases the Inspector's canvas inset",
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
    await page.evaluate(() => {
      window.__ksxStay = 42;
    });
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
    assert.equal(await page.evaluate(() => window.__ksxStay), 42, "staging does not reload");
    await page.waitForFunction(
      (id) =>
        document.activeElement ===
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`)
        .evaluate((item) => item === document.activeElement),
      true,
      "focus moves from the hidden verb to its durable canvas card",
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

  test("Theme and Stage share one lock, including cards added while a request is pending", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-devs-open"]');
    const g915PickerRow = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    if ((await g915PickerRow.getAttribute("aria-pressed")) === "true") {
      await g915PickerRow.click();
    }
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`).count(),
      0,
      "the regression starts with one card available to add during the request",
    );
    let releaseRequest;
    const requestGate = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(`${BASE}/redesign/device`, async (route) => {
      await requestGate;
      await route.continue();
    });
    try {
      const requestStarted = page.waitForRequest(`${BASE}/redesign/device`);
      await page.click(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"] .rd-stagebtn`);
      await requestStarted;
      assert.equal(
        await page.locator('.rd-stageform button[type="submit"]:not(:disabled)').count(),
        0,
        "one Stage request locks every bench-card mutation",
      );
      assert.equal(
        await page.locator('.rd-thememenu button[type="submit"]:not(:disabled)').count(),
        0,
        "Theme cannot race a Stage request's full-payload repaint",
      );

      await page.click('[data-nx="rd-devs-open"]');
      await g915PickerRow.click();
      const newStageButton = page.locator(
        `.forma-canvas-stage [data-instance-id="${G915_SLUG}"] .rd-stagebtn`,
      );
      assert.equal(
        await newStageButton.isDisabled(),
        true,
        "a card mounted during the request immediately inherits the shared lock",
      );
      releaseRequest();
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .staged === "true",
        IPAC_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 0, "the modal stays open");
      assert.equal(
        await g915PickerRow.evaluate((button) => button === document.activeElement),
        true,
        "the delayed response leaves focus with the active picker control",
      );
      assert.equal(
        await page.locator('.rd-thememenu button[type="submit"]:disabled').count(),
        0,
        "the shared lock releases after repaint",
      );
      assert.equal(
        await newStageButton.isDisabled(),
        false,
        "the shared lock also releases a card mounted after the request began",
      );
    } finally {
      releaseRequest();
      await page.unroute(`${BASE}/redesign/device`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("a Stage refresh that loses its board returns focus to the workbench picker", async () => {
    const page = await openBench();
    const card = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    assert.equal(await card.getAttribute("data-staged"), "false");
    await page.route(`${BASE}/api/redesign`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      for (const tier of ["keyboards", "encoders", "experimental"]) {
        payload.devices[tier] = payload.devices[tier].filter((row) => row.selector !== G915);
      }
      await route.fulfill({ response, json: payload });
    });
    try {
      await card.locator(".rd-devcard-name").click();
      await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === false);
      await card.locator(".rd-stagebtn").click();
      await page.waitForFunction(
        (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
        G915_SLUG,
        { timeout: 10_000 },
      );
      const picker = page.locator('[data-nx="rd-devs-open"]');
      assert.equal(
        await picker.evaluate((button) => button === document.activeElement),
        true,
        "focus lands on a durable control when the initiating card disappears",
      );
      assert.equal(
        await page.locator(".rd-inspector[hidden]").count(),
        1,
        "authoritative disappearance closes the removed board's Inspector",
      );
      assert.equal(
        await page.locator(".rd.is-inspector-open").count(),
        0,
        "authoritative disappearance releases the Inspector's safe inset",
      );

      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
      // Measure the UNION of every mounted widget, not one widget: the
      // workbench also carries the staged controller cards now, so a single
      // card legitimately sits off-centre after Fit. A stale Inspector inset
      // would shift the whole union, so the claim under test is unchanged —
      // it is just population-independent.
      const centerError = await page.evaluate(() => {
        const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
        const items = Array.from(
          document.querySelectorAll(".forma-canvas-stage > [data-instance-id]"),
        ).map((item) => item.getBoundingClientRect());
        if (!viewport || items.length === 0) return Number.POSITIVE_INFINITY;
        const left = Math.min(...items.map((r) => r.left));
        const right = Math.max(...items.map((r) => r.right));
        return Math.abs((left + right) / 2 - (viewport.left + viewport.width / 2));
      });
      assert.ok(
        centerError <= 2,
        `Fit still used a stale Inspector inset (${centerError}px from the full canvas centre)`,
      );
    } finally {
      await page.unroute(`${BASE}/api/redesign`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("provider unknown is preserved, authoritative absence unmounts, and return restores geometry", async () => {
    const page = await openBench();
    const item = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    const before = await item.evaluate((node) => ({
      x: Number(node.dataset.canvasX),
      y: Number(node.dataset.canvasY),
      width: Number(node.dataset.canvasWidth),
      height: Number(node.dataset.canvasHeight),
    }));
    let rosterMode = "staging-unreachable";
    await page.route(`${BASE}/api/redesign`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (rosterMode === "staging-unreachable") {
        payload.devices.staging_reachable = false;
        payload.devices.staging_line = "Staging unavailable — test helper did not answer.";
      } else if (rosterMode === "unknown-scan") {
        payload.devices.scan_authoritative = false;
        payload.devices.scan_line = "Device scan unavailable — try again.";
        for (const tier of ["keyboards", "encoders", "experimental", "other"]) {
          payload.devices[tier] = [];
        }
      } else if (rosterMode === "absent") {
        for (const tier of ["keyboards", "encoders", "experimental"]) {
          payload.devices[tier] = payload.devices[tier].filter((row) => row.selector !== G915);
        }
      }
      await route.fulfill({ response, json: payload });
    });
    try {
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="matrix"]) button');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .stagingReachable === "false",
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(
        await item.locator(".rd-stagebtn").isDisabled(),
        true,
        "an unreachable staging provider keeps Stage visible but safely disabled",
      );
      assert.equal(
        await item.locator(".rd-stagebtn").isVisible(),
        true,
        "the disabled action remains discoverable beside its reason",
      );
      assert.match(
        await item.locator(".rd-devcard-staged").textContent(),
        /Staging unavailable/,
      );

      rosterMode = "unknown-scan";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="dark"]) button');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .scanAuthoritative === "false",
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(await item.count(), 1, "a refused scan is unknown, not an empty machine");
      assert.match(await item.locator(".rd-devcard-meta").textContent(), /Status unavailable/);

      rosterMode = "absent";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="light"]) button');
      await page.waitForFunction(
        (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.evaluate((selector) => {
          const saved = JSON.parse(localStorage.getItem("ksx-redesign-canvas") ?? "{}");
          return saved.bench?.includes(selector) === true;
        }, G915),
        true,
        "temporary absence keeps browser-owned membership",
      );

      rosterMode = "full";
      await page.click(".rd-themed > summary");
      await page.click('.rd-thememenu form:has(input[value="system"]) button');
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`)?.dataset
            .canvasX !== undefined,
        G915_SLUG,
        { timeout: 10_000 },
      );
      assert.deepEqual(
        await item.evaluate((node) => ({
          x: Number(node.dataset.canvasX),
          y: Number(node.dataset.canvasY),
          width: Number(node.dataset.canvasWidth),
          height: Number(node.dataset.canvasHeight),
        })),
        before,
        "the returning board reclaims the exact saved geometry",
      );
    } finally {
      await page.unroute(`${BASE}/api/redesign`);
    }
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("removing a non-primary board repaints the surviving multi-selection", async () => {
    const page = await openBench();
    const g915 = page.locator(`.forma-canvas-stage [data-instance-id="${G915_SLUG}"]`);
    const ipac = page.locator(`.forma-canvas-stage [data-instance-id="${IPAC_SLUG}"]`);
    const ipacName = await ipac.getAttribute("data-widget-name");
    await g915.click();
    await ipac.click({ modifiers: ["Shift"] });
    await page.waitForFunction(
      () => document.querySelector(".rd-insp-name")?.textContent === "2 widgets selected",
    );

    await page.click('[data-nx="rd-devs-open"]');
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.waitForFunction(
      (id) => !document.querySelector(`.forma-canvas-stage [data-instance-id="${id}"]`),
      G915_SLUG,
      { timeout: 10_000 },
    );
    assert.equal(
      await ipac.getAttribute("aria-current"),
      "true",
      "the surviving primary remains the selection anchor",
    );
    assert.equal(
      await page.locator(".forma-canvas-stage > .is-active").count(),
      1,
      "the removed non-primary no longer occupies the selection set",
    );
    assert.equal(
      await page.locator(".rd-insp-name").textContent(),
      ipacName,
      "the Inspector repaints from multi-select to the surviving board",
    );

    // Keep the suite's shared arrangement intact for any later regression.
    await page.click(`.rd-devmodal button[data-selector="${G915}"]`);
    await page.keyboard.press("Escape");
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});
