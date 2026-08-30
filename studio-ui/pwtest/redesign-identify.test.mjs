// Identify-by-key on the redesign workbench, in a real browser.
//
// This suite pins what HTTP cannot: the explicit consequence copy, key guard,
// exact-row answer when two products share a name, cancellation/focus
// lifecycle, and a retryable network refusal.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_IDENTIFY_PORT ?? 4550);
const HOLD_PORT = Number(process.env.KSX_PWTEST_REDESIGN_IDENTIFY_HOLD_PORT ?? 4551);
const BASE = `http://127.0.0.1:${PORT}`;
const HOLD_BASE = `http://127.0.0.1:${HOLD_PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");
const IPAC = "usb:d209:0430:00";
const G915 = "usb:046d:c545:00";

let server;
let holdServer;
let browser;

async function waitForServer(base, deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/redesign`)).ok) return;
    } catch {
      // The fixture is still starting.
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${base}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stage(base, selector, alias, label) {
  const response = await fetch(`${base}/redesign/device`, {
    method: "POST",
    body: new URLSearchParams({ selector, alias, label }),
    redirect: "manual",
  });
  assert.equal(response.status, 303, `could not stage ${selector} on ${base}`);
}

async function openRedesign(base) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${base}/redesign`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
  return page;
}

before(async () => {
  for (const base of [BASE, HOLD_BASE]) {
    const occupied = await fetch(`${base}/api/redesign`).then(
      () => true,
      () => false,
    );
    assert.equal(occupied, false, `something is already listening on ${base}`);
  }
  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the redesign identify fixture");
  const fixture = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixture, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  holdServer = spawn(fixture, [String(HOLD_PORT)], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env, KSX_FIXTURE_LEARN: "hold" },
  });
  await Promise.all([waitForServer(BASE), waitForServer(HOLD_BASE)]);
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await Promise.all([
      stopFixtureProcess(server, "redesign identify fixture"),
      stopFixtureProcess(holdServer, "redesign identify hold fixture"),
    ]);
  }
});

describe("redesign identify by key", () => {
  test("an explicit identify resolves the exact connection when product names match", async () => {
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(BASE);
    try {
      // Make the hard ambiguity literal: two instances of the same VID/PID
      // product, differing only by connection identity. The fixture learner
      // resolves MI_00, so the exact selector — not the shared product name —
      // must decide the answer.
      await page.route(`${BASE}/api/redesign*`, async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        for (const tier of ["keyboards", "encoders"]) {
          const row = payload.devices[tier].find((candidate) => candidate.selector === IPAC);
          if (row) {
            row.name = "Arcade Keyboard";
            row.label = "Arcade Keyboard";
            payload.devices[tier].push({
              ...row,
              selector: "usb:d209:0430:01",
              aria_current: "false",
            });
          }
        }
        await route.fulfill({ response, json: payload });
      });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('.rd-devmodal [data-nx="rd-dev-toggle"]'))
          .filter((row) => row.querySelector(".n-dev-name")?.textContent === "Arcade Keyboard")
          .length === 2
      );
      await page.click('[data-nx="rd-devs-open"]');
      assert.equal(
        await page.getByRole("button", { name: /Arcade Keyboard/ }).count(),
        2,
        "the product name alone is genuinely ambiguous",
      );
      assert.equal(
        await page.locator(".rd-dev-identity", { hasText: "USB D209:0430" }).allTextContents(),
        ["USB D209:0430 · connection 00", "USB D209:0430 · connection 01"],
        "true twin boards keep distinct connection labels beside the shared name",
      );
      const action = page.getByRole("button", {
        name: "Identify and use as mapping input",
        exact: true,
      });
      assert.match(
        (await page.locator(".rd-identify-copy").textContent()) ?? "",
        /successful answer becomes the mapping input.*nothing is captured, saved, or started/is,
      );
      await action.click();
      const status = page.locator('[data-rd-identify-status][data-state="identified"]');
      await status.waitFor({ timeout: 15_000 });
      assert.equal(
        (await status.locator("[data-rd-identify-label]").textContent())?.trim(),
        "Identified Arcade Keyboard",
      );
      assert.match(
        (await status.locator("[data-rd-identify-detail]").textContent()) ?? "",
        /USB D209:0430 · connection 00.*exact connection.*mapping input/i,
      );
      assert.equal(
        await page.locator(`.rd-devmodal [data-selector="${IPAC}"][aria-current="true"]`).count(),
        1,
        "the daemon-resolved selector, not the duplicated name, owns the staged mark",
      );
      assert.equal(
        await status.evaluate((element) => element === document.activeElement),
        true,
        "the settled exact-device answer receives focus",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a request failure stays in the picker, explains that nothing changed, and focuses retry", async () => {
    const page = await openRedesign(BASE);
    try {
      await page.route(`${BASE}/redesign/device/identify`, (route) =>
        route.fulfill({ status: 503, body: "fixture refusal" })
      );
      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify and use as mapping input",
        exact: true,
      });
      await action.click();
      const status = page.locator('[data-rd-identify-status][data-state="error"]');
      await status.waitFor();
      assert.match((await status.textContent()) ?? "", /did not answer.*Nothing changed/is);
      assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 0);
      assert.equal(await action.evaluate((button) => button === document.activeElement), true);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Escape cancels the exact pending listener, guards browser keys, and preserves the old input", async () => {
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify and use as mapping input",
        exact: true,
      });
      await action.click();
      const pending = page.locator('[data-rd-identify-status][data-state="listening"]');
      await pending.waitFor();
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      assert.equal(await cancel.evaluate((button) => button === document.activeElement), true);
      assert.equal(
        await page.locator('.rd-devmodal [data-nx="rd-dev-toggle"]:not(:disabled)').count(),
        0,
        "no picker row can turn the identification key into another action",
      );

      const beforeKeys = await page.evaluate(() => ({
        page: window.scrollY,
        panel: document.querySelector(".rd-devmodal-panel")?.scrollTop ?? 0,
      }));
      for (const key of ["Space", "ArrowDown"]) await page.keyboard.press(key);
      assert.deepEqual(
        await page.evaluate(() => ({
          page: window.scrollY,
          panel: document.querySelector(".rd-devmodal-panel")?.scrollTop ?? 0,
        })),
        beforeKeys,
        "keys intended for the daemon cannot scroll the page or picker",
      );
      assert.equal(
        await pending.count(),
        1,
        "Space activated the focused Cancel button instead of being guarded",
      );
      assert.equal(
        await cancel.evaluate((button) => button === document.activeElement),
        true,
        "ArrowDown moved focus while the daemon owned the next key",
      );
      assert.equal(
        await pending.locator(".rd-identify-pulse").evaluate(
          (pulse) => getComputedStyle(pulse).animationName,
        ),
        "none",
        "reduced-motion still animates the listening pulse",
      );
      await page.keyboard.press("Escape");
      const cancelled = page.locator('[data-rd-identify-status][data-state="cancelled"]');
      await cancelled.waitFor({ timeout: 15_000 });
      assert.match((await cancelled.textContent()) ?? "", /cancelled.*Nothing changed/is);
      assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 0);
      assert.equal(await action.evaluate((button) => button === document.activeElement), true);
      const payload = await fetch(`${HOLD_BASE}/api/redesign`).then((response) => response.json());
      const current = [...payload.devices.keyboards, ...payload.devices.encoders]
        .find((row) => row.aria_current === "true");
      assert.equal(current?.selector, G915, "cancel must preserve the prior mapping input");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });
});
