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
import { composeOrderMoving } from "../src/redesign-controller-order.ts";

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
  test("the whole-order permutation seats a card and keeps arrival order", () => {
    assert.equal(composeOrderMoving(["1", "2", "3"], "3", 1), "3 1 2");
    assert.equal(composeOrderMoving(["1", "2", "3"], "1", 3), "2 3 1");
    assert.equal(composeOrderMoving(["1", "2", "3"], "2", 2), "1 2 3");
    assert.equal(
      composeOrderMoving(["1", "2", "3"], "3", 99),
      "1 2 3",
      "an out-of-range position clamps to the end instead of inventing a slot",
    );
  });

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
    // The REAL silhouettes, per the served total record: the Xbox slot
    // wears the Xbox body, the PlayStation slot the DS4 body.
    assert.equal(
      await page.locator(`${cardSel(1)} img.rd-ctrlcard-art`).getAttribute("src"),
      "/_assets/pad-xbox.svg",
    );
    assert.equal(
      await page.locator(`${cardSel(2)} img.rd-ctrlcard-art`).getAttribute("src"),
      "/_assets/pad-ds4.svg",
    );
    // Direct assignment, not spatial arrows: each card wears a Player
    // select at its own position, with a "No player" park option — and no
    // arrow buttons anywhere.
    assert.equal(
      await page.locator(`${cardSel(1)} select.rd-ctrlplayer`).inputValue(),
      "1",
    );
    assert.equal(
      await page.locator(`${cardSel(1)} select.rd-ctrlplayer option`).count(),
      3,
      "two positions plus No player",
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

  test("direct assignment reorders; No player parks and compacts; re-slotting bumps down", async () => {
    const page = await openBench();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(3),
      { timeout: 20_000 },
    );
    const nameAt = (slot) =>
      page
        .locator(`${cardSel(slot)} .rd-ctrlcard-name`)
        .textContent()
        .then((t) => t?.trim());
    // "Make this Player 1": one select change, one whole-order write, the
    // daemon renumbers — the others bump DOWN in arrival order.
    await page.selectOption(`${cardSel(3)} select.rd-ctrlplayer`, "1");
    await page.waitForFunction(
      (sel) =>
        document.querySelector(`${sel} .rd-ctrlcard-name`)?.textContent?.trim() ===
          "Player 3",
      cardSel(1),
      { timeout: 10_000 },
    );
    assert.equal(await nameAt(2), "Player 1", "the old P1 bumped down");
    assert.equal(await nameAt(3), "Player 2");

    // "No player": the card parks as a ghost and the survivors move UP.
    await page.selectOption(`${cardSel(1)} select.rd-ctrlplayer`, "");
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.forma-canvas-stage [data-instance-id^="ctrl-slot-"]')
          .length === 2 &&
        document.querySelectorAll(
          '.forma-canvas-stage [data-instance-id^="ctrl-parked-"]',
        ).length === 1,
      null,
      { timeout: 10_000 },
    );
    assert.equal(await nameAt(1), "Player 1", "the survivors compacted up");
    assert.equal(await nameAt(2), "Player 2");
    const ghost = '.forma-canvas-stage [data-instance-id^="ctrl-parked-"]';
    assert.equal(
      (await page.locator(`${ghost} .rd-ctrlcard-noplayer`).textContent())?.trim(),
      "No player",
      "the ghost wears its orphaned state",
    );
    assert.match(
      (await page.locator(`${ghost} .rd-ctrlcard-meta`).textContent()) ?? "",
      /bindings kept/,
      "the ghost says the studio holds its resurrection material",
    );

    // Re-slot the ghost to Player 1: staged fresh at the top, the others
    // bump down again, the ghost retires. The wait targets the POST-MOVE
    // truth (the re-slotted preset AT slot 1) — "3 slots and no ghost" is
    // already true between the chain's add and its move, and reading names
    // in that gap is the race this predicate exists to close.
    await page.selectOption(`${ghost} select.rd-ctrlplayer`, "1");
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.forma-canvas-stage [data-instance-id^="ctrl-slot-"]')
          .length === 3 &&
        document.querySelectorAll(
          '.forma-canvas-stage [data-instance-id^="ctrl-parked-"]',
        ).length === 0 &&
        document
          .querySelector('.forma-canvas-stage [data-instance-id="ctrl-slot-1"] .rd-ctrlcard-name')
          ?.textContent?.trim() === "Player 3",
      null,
      { timeout: 15_000 },
    );
    assert.equal(
      await page
        .locator(`${cardSel(1)} .rd-ctrlcard-badge`)
        .getAttribute("data-persona"),
      "xbox360",
      "the re-slotted controller sits at Player 1",
    );
    assert.equal(await nameAt(2), "Player 1", "bumped down by the re-slot");
    assert.equal(await nameAt(3), "Player 2");

    // ✕ deletes outright: the space fills up by arrival order.
    await page.click(`${cardSel(1)} form[data-rd-form="controller-remove"] button`);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.forma-canvas-stage [data-instance-id^="ctrl-slot-"]')
          .length === 2,
      null,
      { timeout: 10_000 },
    );
    assert.equal(await nameAt(1), "Player 1");
    assert.equal(await nameAt(2), "Player 2");

    // A ghost's ✕ discards the ghost alone — browser state, no daemon write.
    await page.selectOption(`${cardSel(2)} select.rd-ctrlplayer`, "");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.forma-canvas-stage [data-instance-id^="ctrl-parked-"]',
        ).length === 1,
      null,
      { timeout: 10_000 },
    );
    // The clicks above selected cards, and selection opens the Inspector —
    // which overlays the canvas's right edge where the ghost parked. Close
    // it the way a user would before pressing the ghost's own ✕.
    if (await page.locator(".rd-inspector:not([hidden])").count()) {
      await page.locator('[data-nx="rd-insp-close"]').click();
    }
    await page.click(`${ghost} [data-nx="rd-ctrl-discard"]`);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.forma-canvas-stage [data-instance-id^="ctrl-parked-"]',
        ).length === 0,
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page
        .locator('.forma-canvas-stage [data-instance-id^="ctrl-slot-"]')
        .count(),
      1,
      "discarding a ghost stages nothing",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});
