// Cutover-only browser contracts: the small pieces that would otherwise be
// easy to call "polish" and lose when the legacy surface is retired.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { deviceInstanceId } from "../src/device-instance-id.ts";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_CUTOVER_UX_PORT ?? 4551);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");
const fixtureExe = path.join(
  targetDir,
  "debug",
  "examples",
  process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
);

let server;
let browser;
let context;

const G915 = "usb:046d:c545:00";
const G915_ID = deviceInstanceId(G915);

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/redesign`);
      if (response.ok) return response.json();
    } catch {
      // Fixture still starting.
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function launchFixture() {
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  return waitForServer();
}

async function ensureTwoControllers() {
  let payload = await fetch(`${BASE}/api/redesign`).then((response) => response.json());
  while (payload.controllers.cards.length < 2) {
    const next = payload.controllers.cards.length + 1;
    await fetch(`${BASE}/redesign/controller`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        persona: "xbox360",
        preset: `Cutover P${next}`,
        layout: payload.controllers.add_layout || "keyboard-2p",
      }),
      redirect: "manual",
    });
    payload = await fetch(`${BASE}/api/redesign`).then((response) => response.json());
  }
  return payload;
}

async function openWorkbench() {
  const payload = await ensureTwoControllers();
  const page = await context.newPage();
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/redesign?slot=${payload.controllers.cards[0].number}`, {
    waitUntil: "domcontentloaded",
  });
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
  return { page, payload };
}

async function openControllerInspector(page, slot) {
  const card = `.forma-canvas-stage [data-instance-id="ctrl-slot-${slot}"]`;
  await page.waitForSelector(`${card}[data-canvas-x]`, { timeout: 20_000 });
  await page.locator(`${card} .rd-ctrlcard-slot`).click();
  await page.waitForSelector(".rd-insp-vseg .vc", { timeout: 20_000 });
  if ((await page.locator(".rd-insp-vseg .vc").getAttribute("aria-pressed")) !== "true") {
    await page.locator(".rd-insp-vseg .vc").click();
  }
  await page.waitForSelector(".rd-binding-filter-input", { timeout: 20_000 });
}

async function revealCanvasItem(page, instanceId) {
  await page.waitForSelector(
    `.forma-canvas-stage > [data-instance-id="${instanceId}"][data-canvas-x]`,
    { timeout: 20_000 },
  );
  await page.locator(`.navigator-item[data-instance-id="${instanceId}"]`)
    .evaluate((marker) => marker.click());
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
        ?.getAttribute("aria-current") === "true" &&
      !document.querySelector(".is-camera-animating"),
    instanceId,
    { timeout: 20_000 },
  );
}

async function ensureActiveKeyboard(page) {
  const board = page.locator(
    `.forma-canvas-stage > [data-instance-id="${G915_ID}"][data-selector="${G915}"]`,
  );
  if ((await board.count()) === 0) {
    await page.click('[data-nx="rd-devs-open"]');
    await page.locator(`.rd-devmodal button[data-selector="${G915}"]`).click();
    await page.keyboard.press("Escape");
  } else if ((await board.getAttribute("data-mapping-available")) !== "true") {
    await page.click('[data-nx="rd-devs-open"]');
    const row = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    await row.click();
    await board.waitFor({ state: "detached" });
    await row.click();
    await page.keyboard.press("Escape");
  }
  await revealCanvasItem(page, G915_ID);
  await page.waitForFunction(
    (id) =>
      document.querySelector(
        `.forma-canvas-stage > [data-instance-id="${id}"]`,
      )?.getAttribute("data-mapping-available") === "true",
    G915_ID,
    { timeout: 20_000 },
  );
  return board;
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE}`);
  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the cutover UX fixture");
  await launchFixture();
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
      if (server) await stopFixtureProcess(server, "cutover UX fixture");
    }
  }
});

describe("redesign cutover utility contracts", () => {
  test("controller search is visible, immediate, URL-backed and resettable", async () => {
    const { page, payload } = await openWorkbench();
    const slot = payload.controllers.cards[0].number;
    await openControllerInspector(page, slot);
    const beforeCount = await page.locator(".n-bindgroups > section.n-bindg:not(.empty)").count();
    const search = page.getByLabel("Find a control");
    await search.fill("Face buttons");
    await page.waitForFunction(
      () => new URLSearchParams(location.search).get("q") === "Face buttons",
    );
    assert.match(await page.locator(".rd-binding-filter-count").textContent(), /of \d+ controls/);
    const filteredCount = await page.locator(".n-bindgroups > section.n-bindg:not(.empty)").count();
    assert.ok(filteredCount < beforeCount, "the local sweep hides unmatched groups immediately");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.waitForFunction(() => !new URLSearchParams(location.search).has("q"));
    assert.equal(
      await page.locator(".n-bindgroups > section.n-bindg:not(.empty)").count(),
      beforeCount,
    );
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("identity color follows a controller, survives reload and refuses collisions", async () => {
    const { page, payload } = await openWorkbench();
    const first = payload.controllers.cards[0];
    const second = payload.controllers.cards[1];
    await openControllerInspector(page, first.number);
    const choice = page.locator(".rd-controller-swatch:not(.selected):not(.used)").first();
    const color = await choice.getAttribute("data-color");
    assert.ok(color);
    await choice.click();
    const selectedChoice = page.locator(`.rd-controller-swatch[data-color="${color}"]`);
    assert.equal(await selectedChoice.getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.evaluate((preset) => {
        const saved = JSON.parse(localStorage.getItem("ksx-redesign-controller-colors1") ?? "{}");
        return String(saved[`p:${preset}`] ?? "");
      }, first.preset),
      color,
    );
    assert.equal(
      await page.locator(".nocturne.rd").evaluate((root, slot) =>
        root.style.getPropertyValue(`--pcs${slot}`).trim(), Number(first.number)),
      `var(--pal${color})`,
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
      null,
      { timeout: 20_000 },
    );
    await openControllerInspector(page, first.number);
    assert.equal(
      await page.locator(`.rd-controller-swatch[data-color="${color}"]`).getAttribute("aria-pressed"),
      "true",
    );
    await openControllerInspector(page, second.number);
    const collision = page.locator(`.rd-controller-swatch[data-color="${color}"]`);
    assert.equal(await collision.getAttribute("aria-disabled"), "true");
    assert.match(await collision.getAttribute("aria-label"), /used by Player/);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("twin presets receive deterministic distinct identity keys and colors", async () => {
    const payload = await ensureTwoControllers();
    const twinPreset = payload.controllers.cards[0].preset;
    const firstSlot = payload.controllers.cards[0].number;
    const secondSlot = payload.controllers.cards[1].number;
    const page = await context.newPage();
    const noise = [];
    page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
    await page.addInitScript(() => {
      localStorage.removeItem("ksx-redesign-controller-colors1");
      const provenance = JSON.parse(
        localStorage.getItem("ksx-redesign-state-provenance1") ?? "{}",
      );
      delete provenance["ksx-redesign-controller-colors1"];
      localStorage.setItem("ksx-redesign-state-provenance1", JSON.stringify(provenance));
    });
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      const next = await response.json();
      if (next.controllers.cards.length >= 2) {
        next.controllers.cards[0].preset = twinPreset;
        next.controllers.cards[1].preset = twinPreset;
      }
      await route.fulfill({ response, json: next });
    });
    await page.goto(`${BASE}/redesign?slot=${firstSlot}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (preset) => {
        const saved = JSON.parse(
          localStorage.getItem("ksx-redesign-controller-colors1") ?? "{}",
        );
        return Number.isInteger(saved[`p:${preset}`]) &&
          Number.isInteger(saved[`p:${preset}#2`]);
      },
      twinPreset,
      { timeout: 20_000 },
    );
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("ksx-redesign-controller-colors1") ?? "{}"));
    assert.notEqual(saved[`p:${twinPreset}`], saved[`p:${twinPreset}#2`]);
    await openControllerInspector(page, firstSlot);
    const firstColor = await page.locator(".rd-controller-swatch.selected").getAttribute("data-color");
    await openControllerInspector(page, secondSlot);
    const secondColor = await page.locator(".rd-controller-swatch.selected").getAttribute("data-color");
    assert.notEqual(firstColor, secondColor);
    assert.deepEqual(noise, []);
    await page.close();
  });

  test("Tidy places the physical input above controllers and restores 100 percent", async () => {
    const { page } = await openWorkbench();
    await ensureActiveKeyboard(page);
    await page.waitForSelector('[data-instance-id="ctrl-slot-1"][data-canvas-x]');
    await page.evaluate((keyboardId) => {
      for (const [id, x, y, scale] of [
        [keyboardId, 3200, 2600, 0.65],
        ["ctrl-slot-1", -1200, -900, 1.35],
      ]) {
        const item = document.querySelector(`[data-instance-id="${id}"]`);
        item.dataset.canvasX = String(x);
        item.dataset.canvasY = String(y);
        item.dataset.canvasManualScale = String(scale);
      }
    }, G915_ID);
    await page.locator('[data-nx="rd-zoom-menu"]').click();
    await page.getByRole("menuitem", { name: "Tidy workbench" }).click();
    const state = await page.evaluate((keyboardId) => Object.fromEntries(
      [keyboardId, "ctrl-slot-1"].map((id) => {
        const item = document.querySelector(`[data-instance-id="${id}"]`);
        return [id, {
          x: Number(item.dataset.canvasX),
          y: Number(item.dataset.canvasY),
          scale: Number(item.dataset.canvasManualScale),
        }];
      }),
    ), G915_ID);
    assert.ok(state[G915_ID].y < state["ctrl-slot-1"].y, "input reads before virtual output");
    assert.equal(state[G915_ID].scale, 1);
    assert.equal(state["ctrl-slot-1"].scale, 1);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("Rescan requests an uncached read and support remedies stay visible", async () => {
    const { page } = await openWorkbench();
    await page.locator(".rd-profile-sum").click();
    assert.match(await page.locator(".rd-buildmeta").textContent(), /^v\d/);
    const tools = page.locator(".rd-utility-rail-home [data-rd-tools-menu]");
    await tools.locator(":scope > summary").click();
    await tools.locator('a[href="ms-settings:gaming-gamebar"]').waitFor({ state: "visible" });
    const requests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/redesign")) requests.push(request.url());
    });
    await page.locator('[data-nx="rd-devs-open"]').click();
    await page.getByRole("button", { name: "Rescan connected devices" }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-nx="rd-rescan"]')?.textContent === "Rescan",
    );
    assert.ok(
      requests.some((url) => new URL(url).searchParams.get("fresh") === "1"),
      `expected fresh=1 request, saw ${requests.join(", ")}`,
    );
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("a fixture reseed clears only fixture-owned redesign state", async () => {
    const first = await fetch(`${BASE}/api/redesign`).then((response) => response.json());
    const protectedBytes = {
      canvas: JSON.stringify({ widgets: {}, realCanvasSentinel: "keep" }),
      ui: JSON.stringify({ inspTab: "controls", realUserSentinel: "keep" }),
      colors: JSON.stringify({ "p:Real user controller": 6 }),
      strips: JSON.stringify(["real-user-preset"]),
    };
    const statePage = await context.newPage();
    await statePage.goto(`${BASE}/api/redesign`, { waitUntil: "domcontentloaded" });
    await statePage.evaluate(({ bytes }) => {
      localStorage.setItem("ksx-redesign-canvas", bytes.canvas);
      localStorage.setItem("ksx-redesign-ui", bytes.ui);
      localStorage.setItem("ksx-redesign-controller-colors1", bytes.colors);
      localStorage.setItem("ksx-nocturne-strips2", bytes.strips);
      localStorage.setItem(
        "ksx-redesign-state-provenance1",
        JSON.stringify({
          "ksx-redesign-canvas": {
            environmentId: "live-machine",
            generation: "real-user",
            fixture: false,
          },
          "ksx-redesign-ui": {
            environmentId: "live-machine",
            generation: "real-user",
            fixture: false,
          },
          "ksx-nocturne-strips2": {
            environmentId: "live-machine",
            generation: "real-user",
            fixture: false,
          },
        }),
      );
    }, { bytes: protectedBytes });
    await statePage.close();

    // Exercise every writer while the fixture is looking at protected state.
    // Permission is decided before setItem, so these visible in-memory edits
    // must leave the real/unmarked bytes exactly untouched.
    const { page: protectedPage, payload } = await openWorkbench();
    await openControllerInspector(protectedPage, payload.controllers.cards[0].number);
    await protectedPage.locator(".rd-insp-vseg .vk").click();
    await protectedPage.locator(".rd-controller-swatch:not(.selected):not(.used)").first().click();
    await protectedPage.locator('[data-nx="legend-mute"]').first().evaluate((button) => button.click());
    await protectedPage.locator('[data-nx="rd-zoom-menu"]').click();
    await protectedPage.getByRole("menuitem", { name: "Tidy workbench" }).click();
    await protectedPage.close();
    const verifyPage = await context.newPage();
    await verifyPage.goto(`${BASE}/api/redesign`, { waitUntil: "domcontentloaded" });
    const unchanged = await verifyPage.evaluate(() => ({
      canvas: localStorage.getItem("ksx-redesign-canvas"),
      ui: localStorage.getItem("ksx-redesign-ui"),
      colors: localStorage.getItem("ksx-redesign-controller-colors1"),
      strips: localStorage.getItem("ksx-nocturne-strips2"),
    }));
    assert.deepEqual(unchanged, protectedBytes, "fixture writes stay memory-only");

    // Now make only the canvas store fixture-owned. The next generation may
    // clear it, while the real-owned UI and unmarked color bytes must remain.
    await verifyPage.evaluate(({ environmentId, generation }) => {
      localStorage.setItem(
        "ksx-redesign-canvas",
        JSON.stringify({
          widgets: {
            "fixture-only-sentinel": {
              x: 1, y: 2, width: 300, height: 220, z: 1, manualScale: 1,
            },
          },
        }),
      );
      const provenance = JSON.parse(
        localStorage.getItem("ksx-redesign-state-provenance1") ?? "{}",
      );
      provenance["ksx-redesign-canvas"] = { environmentId, generation, fixture: true };
      localStorage.setItem("ksx-nocturne-strips2", JSON.stringify(["fixture-only-strip"]));
      provenance["ksx-nocturne-strips2"] = { environmentId, generation, fixture: true };
      delete provenance["ksx-redesign-controller-colors1"];
      localStorage.setItem("ksx-redesign-state-provenance1", JSON.stringify(provenance));
    }, { environmentId: first.environment_id, generation: first.environment_generation });
    await verifyPage.close();

    await stopFixtureProcess(server, "cutover UX fixture reseed");
    server = null;
    const second = await launchFixture();
    assert.notEqual(second.environment_generation, first.environment_generation);

    const page = await context.newPage();
    await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
      null,
      { timeout: 20_000 },
    );
    const stores = await page.evaluate(() => ({
      canvas: JSON.parse(localStorage.getItem("ksx-redesign-canvas") ?? "{}"),
      uiBytes: localStorage.getItem("ksx-redesign-ui"),
      colorBytes: localStorage.getItem("ksx-redesign-controller-colors1"),
      strips: JSON.parse(localStorage.getItem("ksx-nocturne-strips2") ?? "[]"),
    }));
    assert.equal(stores.canvas.widgets?.["fixture-only-sentinel"], undefined);
    assert.equal(stores.uiBytes, protectedBytes.ui, "real-owned bytes are never cleared or changed");
    assert.equal(stores.colorBytes, protectedBytes.colors, "unmarked bytes are never adopted or changed");
    assert.ok(!stores.strips.includes("fixture-only-strip"), "stale fixture strip state is removed");
    await page.close();
  });
});
