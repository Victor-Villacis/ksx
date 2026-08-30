// Focused browser regressions for the redesign refresh coordinator and mapper.
// These races are interaction state: unit composition cannot prove them.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_HARDENING_PORT ?? 4543);
const BASE = `http://127.0.0.1:${PORT}`;
const LEARN_ROUTES = /\/api\/learn(?:\/.*)?$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;
let slotOne;
let slotTwo;

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/redesign`);
      if (response.ok) return;
    } catch {
      // The fixture is still starting.
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const api = async () => (await fetch(`${BASE}/api/redesign`)).json();

async function bind(slot, fn, key, revision, force = true) {
  const response = await fetch(`${BASE}/redesign/api/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slot: Number(slot),
      expected_target_revision: revision,
      function: fn,
      key,
      mode: null,
      force,
    }),
  });
  return response.json();
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
  assert.equal(built.status, 0, "could not build the redesign hardening fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer();
  browser = await chromium.launch();

  let payload = await api();
  if (payload.controllers.pads.length < 2) {
    await fetch(`${BASE}/redesign/controller`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "persona=xbox360&preset=Hardening+P2&layout=keyboard-2p",
      redirect: "manual",
    });
    payload = await api();
  }
  assert.ok(payload.controllers.pads.length >= 2, "two seats are required for a conflict");
  slotOne = String(payload.controllers.pads[0].slot);
  slotTwo = String(payload.controllers.pads[1].slot);
  assert.equal(
    (await bind(slotOne, "A", "H", payload.controllers.pads[0].target_revision)).ok,
    true,
  );
  payload = await api();
  assert.equal(
    (await bind(slotTwo, "B", "G", payload.controllers.pads[1].target_revision)).ok,
    true,
  );
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "redesign migration hardening fixture");
  }
});

async function openBench() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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

async function openPanel(page, slot) {
  const instanceId = `ctrl-slot-${slot}`;
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"][data-canvas-x]`,
    ),
    instanceId,
    { timeout: 20_000 },
  );
  await page.locator(`.navigator-item[data-instance-id="${instanceId}"]`)
    .evaluate((marker) => marker.click());
  await page.waitForFunction(
    (id) =>
      document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
        ?.getAttribute("aria-current") === "true" &&
      !document.querySelector(".is-camera-animating"),
    instanceId,
    { timeout: 20_000 },
  );
  await page.click(
    `.forma-canvas-stage [data-instance-id="${instanceId}"] .rd-ctrlcard-slot`,
  );
  await page.waitForFunction(
    (want) =>
      document.querySelector(".rd-insp-vseg .vc") &&
      new URL(window.location.href).searchParams.get("slot") === want,
    String(slot),
    { timeout: 20_000 },
  );
  if ((await page.locator(".rd-insp-vseg .vc").getAttribute("aria-pressed")) !== "true") {
    await page.click(".rd-insp-vseg .vc");
  }
  await page.waitForFunction(
    () => document.querySelectorAll(".rd-insp-body .n-bindg-head").length === 6,
    null,
    { timeout: 20_000 },
  );
}

describe("redesign migration hardening", { concurrency: false }, () => {
  test("a pre-write background payload cannot arrive after the action repaint", async () => {
    const page = await openBench();
    const original = await page.locator('.rd-thememenu button[aria-current="true"]')
      .evaluate((button) => button.closest("form")?.querySelector("input")?.value ?? "system");
    const target = original === "matrix" ? "midnight" : "matrix";

    let releaseOld;
    let markOldStarted;
    const oldGate = new Promise((resolve) => {
      releaseOld = resolve;
    });
    const oldStarted = new Promise((resolve) => {
      markOldStarted = resolve;
    });
    let held = false;
    await page.route("**/api/redesign*", async (route) => {
      const response = await route.fetch();
      if (!held) {
        held = true;
        markOldStarted();
        await oldGate;
        try {
          await route.fulfill({ response });
        } catch {
          // The coordinator aborts this stale browser request on purpose.
        }
        return;
      }
      await route.fulfill({ response });
    });

    await Promise.race([
      oldStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("poll did not start")), 6000)),
    ]);
    await page.click(".rd-themed > summary");
    await page.click(`.rd-thememenu form:has(input[value="${target}"]) button`);
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      target,
      { timeout: 10_000 },
    );
    releaseOld();
    await page.waitForTimeout(350);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      target,
      "the held pre-write payload must not repaint over the action",
    );
    await page.unroute("**/api/redesign*");

    // Leave shared fixture state as this test found it.
    await page.click(".rd-themed > summary");
    await page.click(`.rd-thememenu form:has(input[value="${original}"]) button`);
    await page.waitForFunction(
      (theme) =>
        theme === "system"
          ? document.documentElement.dataset.theme === undefined
          : document.documentElement.dataset.theme === theme,
      original,
      { timeout: 10_000 },
    );
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("the conflict question traps Tab and returns focus to its opener", async () => {
    const page = await openBench();
    await openPanel(page, slotOne);
    const chip = page.locator(
      '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
    );
    await chip.click();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display !== "none",
      null,
      { timeout: 20_000 },
    );
    assert.equal(await page.locator(".rd-confdlg .nd").getAttribute("aria-modal"), "true");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".rd-confdlg .nd")),
      true,
      "the modal itself receives initial focus",
    );
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Use here too");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim()),
      "Cancel",
      "Tab wraps inside the consequence dialog",
    );
    // Let the two-second payload tick rebuild the Inspector behind the modal.
    // The opener element is now detached; restoration must resolve its stable
    // fn/slot/verb identity onto the replacement chip.
    await page.waitForTimeout(2300);
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display === "none",
    );
    assert.equal(
      await chip.evaluate((button) => button === document.activeElement),
      true,
      "dismissal restores the initiating mapping chip",
    );

    // Accepting takes the slower path: the write refreshes the inspector and
    // controller art before focus may return. The logical opener must still
    // win after that replacement, not the page body.
    await chip.click();
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display !== "none",
      null,
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: "Use here too" }).click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".rd-confdlg")).display === "none" &&
        document.activeElement?.matches(
          '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
        ),
      null,
      { timeout: 20_000 },
    );
    assert.equal(
      await chip.evaluate((button) => button === document.activeElement),
      true,
      "accepted conflict restores focus after the authoritative repaint",
    );

    // Restore the shared fixture's baseline mapping for later tests.
    const current = (await api()).controllers.pads.find(
      (pad) => String(pad.slot) === slotOne,
    );
    assert.equal((await bind(slotOne, "A", "H", current.target_revision)).ok, true);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("accepted conflict does not steal focus moved during its delayed write", async () => {
    const page = await openBench();
    await openPanel(page, slotOne);
    let generation = 17_000;
    await page.route(LEARN_ROUTES, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/learn/start") generation += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          ok: true,
          state: pathname.endsWith("/cancel") ? "cancelled" : "listening",
          generation,
          remaining_ms: 10_000,
          device: null,
          selector: null,
          key: null,
          error: null,
        },
      });
    });

    await page.locator(
      '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
    ).click();
    await page.waitForFunction(
      () => document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 10_000 },
    );
    await page.locator(
      '[data-instance-id="keyboard"] button.n-key[data-key="G"]',
    ).first().evaluate((cell) => {
      cell.focus();
      cell.click();
    });
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display !== "none",
      null,
      { timeout: 20_000 },
    );

    let releaseForce;
    let markForceStarted;
    const forceGate = new Promise((resolve) => {
      releaseForce = resolve;
    });
    const forceStarted = new Promise((resolve) => {
      markForceStarted = resolve;
    });
    await page.route("**/redesign/api/bind", async (route) => {
      markForceStarted();
      const response = await route.fetch();
      await forceGate;
      await route.fulfill({ response });
    });

    await page.getByRole("button", { name: "Use here too" }).click();
    await Promise.race([
      forceStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("forced bind did not start")), 3000)),
    ]);
    await page.evaluate(() => {
      const probe = document.createElement("button");
      probe.id = "deliberate-focus-after-conflict";
      probe.textContent = "Deliberate focus destination";
      document.body.append(probe);
      probe.focus();
    });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "deliberate-focus-after-conflict",
      "the focus probe owns focus while the accepted write is pending",
    );

    releaseForce();
    await page.waitForFunction(
      () =>
        document.querySelector(
          '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
        )?.textContent?.trim() === "G",
      null,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "deliberate-focus-after-conflict",
      "accepted-conflict completion must not take focus from a new live control",
    );

    const current = (await api()).controllers.pads.find(
      (pad) => String(pad.slot) === slotOne,
    );
    assert.equal((await bind(slotOne, "A", "H", current.target_revision)).ok, true);
    await page.unroute("**/redesign/api/bind");
    await page.unroute(LEARN_ROUTES);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("a terminal learn-start refusal retires the auto-map walk", async () => {
    // Keep this test independent of the fixture mutations made by earlier
    // cases: auto-map needs at least one concrete unbound destination.
    await fetch(`${BASE}/redesign/bind/clear`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `slot=${slotOne}&function=${encodeURIComponent("rx.max")}`,
      redirect: "manual",
    });
    const page = await openBench();
    await openPanel(page, slotOne);
    let failStart = true;
    let generation = 12_000;
    let markFailedStart;
    const failedStart = new Promise((resolve) => {
      markFailedStart = resolve;
    });
    await page.route(LEARN_ROUTES, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/learn/start" && failStart) {
        markFailedStart();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            ok: false,
            state: "cancelled",
            generation: null,
            remaining_ms: 0,
            device: null,
            selector: null,
            key: null,
            error: "Key listening could not start — fixture refusal.",
          },
        });
        return;
      }
      if (pathname === "/api/learn/start") generation += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          ok: true,
          state: pathname.endsWith("/cancel") ? "cancelled" : "listening",
          generation,
          remaining_ms: 10_000,
          device: null,
          selector: null,
          key: null,
          error: null,
        },
      });
    });

    await page.click('[data-nx="rd-automap"]');
    const attempted = await Promise.race([
      failedStart.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!attempted) {
      const browserState = await page.evaluate(() => ({
        flash: document.querySelector(".rd-flash")?.textContent,
        learn: document.querySelector(".rd-learn-line")?.textContent,
        mapAllDisabled: document.querySelector('[data-nx="rd-automap"]')?.disabled,
        mapAllCount: document.querySelectorAll('[data-nx="rd-automap"]').length,
      }));
      const payload = await api();
      const pad = payload.controllers.pads.find((row) => String(row.slot) === slotOne);
      throw new Error(`auto-map never attempted its first listener: ${JSON.stringify({
        browserState,
        learnSelector: payload.learn_selector,
        learnInstance: payload.learn_instance,
        unbound: pad?.controls?.filter((control) => control.keys.length === 0).length,
      })}`);
    }
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-learnbar")).display === "none",
      null,
      { timeout: 10_000 },
    );
    assert.match(
      (await page.locator(".rd-flash").textContent()) ?? "",
      /Key listening could not start/,
    );
    failStart = false;
    await page.locator(
      '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
    ).click();
    await page.waitForFunction(
      () => document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 10_000 },
    );
    assert.doesNotMatch(
      (await page.locator(".rd-learn-line").textContent()) ?? "",
      /\b\d+ of \d+\b/,
      "an ordinary retry cannot inherit the failed auto-map queue",
    );
    await page.keyboard.press("Escape");
    await page.unroute(LEARN_ROUTES);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("toggling the armed row cancels the whole auto-map walk", async () => {
    await fetch(`${BASE}/redesign/bind/clear`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `slot=${slotOne}&function=${encodeURIComponent("rx.max")}`,
      redirect: "manual",
    });
    const page = await openBench();
    await openPanel(page, slotOne);
    let generation = 20_000;
    let markCancelObserved;
    const cancelObserved = new Promise((resolve) => {
      markCancelObserved = resolve;
    });
    await page.route(LEARN_ROUTES, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/learn/start") generation += 1;
      if (pathname.endsWith("/cancel")) markCancelObserved();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          ok: true,
          state: pathname.endsWith("/cancel") ? "cancelled" : "listening",
          generation,
          remaining_ms: 10_000,
          device: null,
          selector: null,
          key: null,
          error: null,
        },
      });
    });

    await page.click('[data-nx="rd-automap"]');
    await page.waitForFunction(
      () => /\b1 of \d+\b/.test(document.querySelector(".rd-learn-line")?.textContent ?? ""),
      null,
      { timeout: 10_000 },
    );
    const armedTrigger = page.locator(
      '.rd-insp-body details.n-bind.arm [data-nx="chip-learn"], ' +
        '.rd-insp-body .n-ctlchip.arm[data-nx="ctl-assign"]',
    ).first();
    assert.equal(await armedTrigger.count(), 1, "auto-map must mark one clickable control");
    await armedTrigger.click();
    await Promise.race([
      cancelObserved,
      new Promise((_, reject) => setTimeout(() => reject(new Error("listener cancel was not sent")), 3000)),
    ]);
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-learnbar")).display === "none",
      null,
      { timeout: 10_000 },
    );

    await page.locator(
      '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
    ).click();
    await page.waitForFunction(
      () => document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 10_000 },
    );
    assert.doesNotMatch(
      (await page.locator(".rd-learn-line").textContent()) ?? "",
      /\b\d+ of \d+\b/,
      "the next ordinary learn must not inherit the cancelled walk",
    );
    await page.keyboard.press("Escape");
    await page.unroute(LEARN_ROUTES);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("a keyboard-cell conflict returns to the replacement key after confirm", async () => {
    const page = await openBench();
    await openPanel(page, slotOne);
    let generation = 15_000;
    await page.route(LEARN_ROUTES, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/learn/start") generation += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          ok: true,
          state: pathname.endsWith("/cancel") ? "cancelled" : "listening",
          generation,
          remaining_ms: 10_000,
          device: null,
          selector: null,
          key: null,
          error: null,
        },
      });
    });

    await page.locator(
      '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
    ).click();
    await page.waitForFunction(
      () => document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 10_000 },
    );
    const keyCell = page.locator(
      '[data-instance-id="keyboard"] button.n-key[data-key="G"]',
    ).first();
    await keyCell.evaluate((cell) => {
      cell.focus();
      cell.click();
    });
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display !== "none",
      null,
      { timeout: 20_000 },
    );
    await page.getByRole("button", { name: "Use here too" }).click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".rd-confdlg")).display === "none" &&
        document.activeElement?.matches(
          '[data-instance-id="keyboard"] button.n-key[data-key="G"]',
        ),
      null,
      { timeout: 20_000 },
    );
    assert.equal(await keyCell.evaluate((cell) => cell === document.activeElement), true);

    const current = (await api()).controllers.pads.find(
      (pad) => String(pad.slot) === slotOne,
    );
    assert.equal((await bind(slotOne, "A", "H", current.target_revision)).ok, true);
    await page.unroute(LEARN_ROUTES);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("an external revision retires the whole auto-map walk", async () => {
    await fetch(`${BASE}/redesign/bind/clear`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `slot=${slotOne}&function=${encodeURIComponent("rx.max")}`,
      redirect: "manual",
    });
    const page = await openBench();
    await openPanel(page, slotOne);

    let generation = 9000;
    await page.route(LEARN_ROUTES, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/learn/start") generation += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          ok: true,
          state: pathname.endsWith("/cancel") ? "cancelled" : "listening",
          generation,
          remaining_ms: 10_000,
          device: null,
          selector: null,
          key: null,
          error: null,
        },
      });
    });

    await page.click('[data-nx="rd-automap"]');
    await page.waitForFunction(
      () => /\b1 of \d+\b/.test(document.querySelector(".rd-learn-line")?.textContent ?? ""),
      null,
      { timeout: 10_000 },
    );
    const before = (await api()).controllers.pads.find(
      (pad) => String(pad.slot) === slotOne,
    );
    assert.equal((await bind(slotOne, "A", "J", before.target_revision)).ok, true);
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-learnbar")).display === "none",
      null,
      { timeout: 7000 },
    );

    const ordinary = page.locator(
      '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
    );
    await ordinary.click();
    await page.waitForFunction(
      () => document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 10_000 },
    );
    assert.doesNotMatch(
      (await page.locator(".rd-learn-line").textContent()) ?? "",
      /\b\d+ of \d+\b/,
      "the next ordinary learn must not inherit the retired walk",
    );
    await page.keyboard.press("Escape");
    await page.unroute(LEARN_ROUTES);
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });
});
