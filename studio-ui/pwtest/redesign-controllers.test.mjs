// The controller workbench, in a real browser.
//
// WHY THIS LEVEL: the Rust tests pin the composition (tier'd reorder strings,
// served ceilings, the roster's honesty) and the verbs' transport. Only a
// browser can pin the workbench: that the STAGED rack stands on the canvas
// from first paint (daemon truth, not browser arrangement), that adding from
// the picker grows the rack in place, that one reorder press renumbers
// through the daemon, and that remove retires the card.
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
const PORT = Number(process.env.KSX_PWTEST_REDESIGN_CONTROLLERS_PORT ?? 4532);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;
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
  assert.equal(built.status, 0, "could not build the ksx-studio controllers fixture");
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
      await stopFixtureProcess(server, "controllers fixture");
    }
  }
});

const cardSel = (slot) => `.forma-canvas-stage [data-instance-id="ctrl-slot-${slot}"]`;

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

describe("the controller workbench", () => {
  test("the staged rack stands on the canvas from first paint — daemon truth, not arrangement", async () => {
    const page = await openBench();
    for (const slot of [1, 2]) {
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
        cardSel(slot),
        { timeout: 20_000 },
      );
    }
    assert.equal(
      (await page.locator(`${cardSel(1)} .rd-ctrlcard-name`).textContent())?.trim(),
      "Player 1",
    );
    assert.match(
      (await page.locator(`${cardSel(1)} .rd-ctrlcard-meta`).textContent()) ?? "",
      /XInput/,
      "the Xbox slot prices its XInput cost",
    );
    assert.match(
      (await page.locator(`${cardSel(2)} .rd-ctrlcard-meta`).textContent()) ?? "",
      /no XInput slot/,
      "the PlayStation slot says it takes none of the four",
    );
    // The top card cannot move up, the bottom cannot move down — served
    // honesty, disabled, never a dead POST.
    assert.equal(
      await page.locator(`${cardSel(1)} .rd-ctrlcard-verbs button:disabled`).count(),
      1,
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the picker serves the roster with served ceilings; adding stages the next slot in place", async () => {
    const page = await openBench();
    await page.click('[data-nx="rd-ctrls-open"]');
    assert.equal(await page.locator(".rd-ctrlmodal[hidden]").count(), 0, "the modal opens");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.matches('.rd-ctrlmodal button[data-nx="rd-ctrls-close"]')
      ),
      true,
      "the picker lands on its first reliable control",
    );
    assert.match(
      (await page.locator(".rd-ctrl-counts").textContent()) ?? "",
      /2 of 16 slots staged · 1 of 4 Xbox \(XInput\)/,
      "every ceiling in the counts line is the daemon's",
    );
    const xbox = page.locator(
      '.rd-ctrlmodal form[data-rd-form="controller-add"][data-usable="true"]',
      { has: page.locator('input[name="persona"][value="xbox360"]') },
    );
    assert.ok((await xbox.count()) >= 1, "the Xbox persona is offered");
    await xbox.first().locator("button").click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(3),
      { timeout: 10_000 },
    );
    assert.equal(
      await page.locator(".rd-ctrlmodal[hidden]").count(),
      0,
      "the picker stays open — staging several in one visit is the point",
    );
    await page.waitForFunction(
      () => document.querySelector(".rd-ctrl-counts")?.textContent?.includes("3 of 16"),
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".rd-flash")?.textContent ===
          "Draft updated. Nothing has been saved or started.",
      null,
      { timeout: 10_000 },
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rd-ctrlmodal[hidden]").count(), 1);
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("one reorder press renumbers through the daemon; remove retires the card", async () => {
    const page = await openBench();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(3),
      { timeout: 20_000 },
    );
    assert.equal(
      (await page.locator(`${cardSel(3)} .rd-ctrlcard-name`).textContent())?.trim(),
      "Player 3",
    );
    // Move the third card up one place: the daemon renumbers, so the SAME
    // preset now answers from slot 2.
    await page.click(`${cardSel(3)} .rd-ctrlcard-verbs form[data-rd-form="controller-move"]:first-of-type button`);
    await page.waitForFunction(
      (sel) =>
        document.querySelector(`${sel} .rd-ctrlcard-name`)?.textContent?.trim() ===
          "Player 3",
      cardSel(2),
      { timeout: 10_000 },
    );
    // Remove it: the rack shrinks and the card retires.
    await page.click(`${cardSel(2)} form[data-rd-form="controller-remove"] button`);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.forma-canvas-stage [data-instance-id^="ctrl-slot-"]')
          .length === 2,
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll(".rd-ctrlcard-name"),
          ).some((name) => name.textContent?.trim() === "Player 3"),
      ),
      false,
      "the removed slot's card is gone",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});
