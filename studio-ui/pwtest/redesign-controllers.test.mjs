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
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";
import { composeOrderMoving } from "../src/redesign-controller-order.ts";
import { deviceInstanceId } from "../src/device-instance-id.ts";

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
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
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
const G915 = "usb:046d:c545:00";
const G915_ID = deviceInstanceId(G915);
const IPAC = "usb:d209:0430:00";
const IPAC_ID = deviceInstanceId(IPAC);

const api = async () => (await fetch(`${BASE}/api/redesign`)).json();

function exactSource(pad, selector) {
  const source = pad?.sources?.find(
    (candidate) => (candidate.source_id ?? candidate.sourceId) === selector,
  );
  assert.ok(source, `Player ${pad?.slot ?? "?"} must expose exact source ${selector}`);
  assert.ok(source.revision, `exact source ${selector} must carry its own revision`);
  return source;
}

async function sourceAuthority(slot, selector) {
  const pad = (await api()).controllers.pads.find(
    (candidate) => String(candidate.slot) === String(slot),
  );
  assert.ok(pad, `Player ${slot} must exist`);
  return exactSource(pad, selector);
}

async function bindExact(slot, fn, key, selector, force = true) {
  const source = await sourceAuthority(slot, selector);
  const response = await fetch(`${BASE}/redesign/api/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slot: Number(slot),
      expected_device: selector,
      expected_target_revision: source.revision,
      function: fn,
      key,
      mode: null,
      force,
    }),
  });
  return response.json();
}

async function clearExact(slot, fn, selector) {
  const source = await sourceAuthority(slot, selector);
  const response = await fetch(`${BASE}/redesign/bind/clear`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      slot: String(slot),
      source: selector,
      expected_target_revision: source.revision,
      function: fn,
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 303, `could not clear ${fn} for exact source ${selector}`);
  return response;
}

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

/** Navigate through the canvas's own minimap before pressing controls that
 *  semantic zoom intentionally hides at overview distance. */
async function revealCanvasItem(page, instanceId) {
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"][data-canvas-x]`,
    ),
    instanceId,
  );
  await page.locator(`.navigator-item[data-instance-id="${instanceId}"]`)
    .evaluate((marker) => marker.click());
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"]`,
    )?.getAttribute("aria-current") === "true" &&
      !document.querySelector(".is-camera-animating"),
    instanceId,
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
  await page.waitForFunction(
    (id) => document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)?.dataset.canvasX !== undefined,
    G915_ID,
  );
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"]`,
    )?.dataset.mappingAvailable === "true",
    G915_ID,
    { timeout: 20_000 },
  );
  return board;
}

async function ensureActiveEncoder(page) {
  const board = page.locator(
    `.forma-canvas-stage > [data-instance-id="${IPAC_ID}"][data-selector="${IPAC}"]`,
  );
  if ((await board.count()) === 0) {
    await page.click('[data-nx="rd-devs-open"]');
    await page.locator(`.rd-devmodal button[data-selector="${IPAC}"]`).click();
    await page.keyboard.press("Escape");
  } else if ((await board.getAttribute("data-mapping-available")) !== "true") {
    await page.click('[data-nx="rd-devs-open"]');
    const row = page.locator(`.rd-devmodal button[data-selector="${IPAC}"]`);
    await row.click();
    await board.waitFor({ state: "detached" });
    await row.click();
    await page.keyboard.press("Escape");
  }
  await page.waitForFunction(
    (id) => document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)?.dataset.canvasX !== undefined,
    IPAC_ID,
  );
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"]`,
    )?.dataset.mappingAvailable === "true",
    IPAC_ID,
    { timeout: 20_000 },
  );
  return board;
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
    // The REAL silhouettes: each card CLONES the shared hidden master for
    // its served family (nocturne's widget mechanism — five masters, one
    // drawing each), and the clone's callouts are dressed from the slot's
    // OWN served fn→keys table.
    assert.equal(
      await page.locator(".n-padmasters .n-padwrap").count(),
      5,
      "the five shared masters are mounted as clone templates",
    );
    assert.equal(
      await page.locator(`${cardSel(1)} svg.wspad.x360a`).count(),
      1,
      "the Xbox slot wears the Xbox 360 clone",
    );
    assert.equal(
      await page.locator(`${cardSel(2)} svg.ds4premium`).count(),
      1,
      "the PlayStation slot wears the DS4 premium clone",
    );
    const callouts = await page
      .locator(`${cardSel(1)} text.n-fnkey`)
      .evaluateAll((nodes) => nodes.map((n) => n.textContent).filter(Boolean));
    assert.ok(
      callouts.length > 0,
      "the fixture layout's bindings dress the clone's callouts",
    );
    assert.equal(
      await page.locator(`${cardSel(2)} .n-ds4-variant`).count(),
      4,
      "the DS4 finish swatches ride the card head (the shared padFinishes store)",
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

  test("the Add tray serves the roster while the next slot appears on the live canvas", async () => {
    const page = await openBench();
    const opener = page.locator('[data-nx="rd-ctrls-open"]');
    await opener.click();
    assert.equal(await page.locator(".rd-ctrlmodal[hidden]").count(), 0, "the tray opens");
    assert.equal(await opener.getAttribute("aria-expanded"), "true");
    assert.equal(await opener.getAttribute("aria-controls"), "rd-controller-picker");
    assert.equal(
      await page.locator("#rd-controller-picker").getAttribute("aria-modal"),
      null,
      "the controller catalog does not make the visible canvas inert",
    );
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".rd-ctrlmodal-panel")?.getBoundingClientRect();
      const canvas = document.querySelector(".n-canvas")?.getBoundingClientRect();
      return panel && canvas ? { panelRight: panel.right, canvasLeft: canvas.left } : null;
    });
    assert.ok(geometry);
    assert.ok(geometry.panelRight <= geometry.canvasLeft);
    assert.ok(
      geometry.canvasLeft - geometry.panelRight <= 24,
      "the controller catalog and canvas occupy separate space with only the normal gutter",
    );
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
      "the tray stays open — staging several in one visit is the point",
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
    await xbox.first().locator("button").click();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(4),
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => document.querySelector(".rd-ctrl-counts")?.textContent?.includes("4 of 16"),
      null,
      { timeout: 10_000 },
    );
    assert.match(
      (await page.locator(".rd-ctrl-counts").textContent()) ?? "",
      /4 of 16 slots staged · 3 of 4 Xbox \(XInput\)/,
      "a second click after the repaint retains the persona and defaults",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest("form")?.dataset.persona),
      "xbox360",
      "rapid multi-add restores focus to the same durable persona row",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".rd-ctrlmodal[hidden]").count(), 1);
    assert.equal(await opener.getAttribute("aria-expanded"), "false");
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('[data-nx="rd-ctrls-open"]')),
      true,
      "Escape returns to the catalog opener",
    );
    // Restore the suite's three-slot starting point through the real card
    // verb; later reorder coverage intentionally begins with slots 1–3.
    await revealCanvasItem(page, "ctrl-slot-4");
    await page.click(`${cardSel(4)} form[data-rd-form="controller-remove"] button`);
    await page.waitForFunction(
      (sel) => !document.querySelector(sel),
      cardSel(4),
      { timeout: 10_000 },
    );
    await revealCanvasItem(page, "ctrl-slot-3");
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("direct assignment reorders; No player parks and compacts; re-slotting bumps down", async () => {
    const page = await openBench();
    await revealCanvasItem(page, "ctrl-slot-3");
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
    assert.equal(
      await page.locator(`${ghost} [data-fn], ${ghost} [data-rd-pad-action]`).count(),
      0,
      "a parked drawing cannot route mapping gestures to a live player",
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
    await revealCanvasItem(page, "ctrl-slot-1");
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
    // The pad-sized ghost may sit outside the current camera. Navigate to it
    // through the real minimap contract so editing-distance verbs reappear.
    const ghostId = await page.locator(ghost).getAttribute("data-instance-id");
    assert.ok(ghostId);
    await revealCanvasItem(page, ghostId);
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

  test("the server blueprint keeps real keys truthful without inventing canvas membership", async () => {
    const ssrContext = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
      javaScriptEnabled: false,
    });
    try {
      const page = await ssrContext.newPage();
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      const real = page.locator(
        '[data-rd-keyboard-surface-template-body] button.n-key:not(.ghost)[data-key]:not([data-key=""])',
      );
      const spacers = page.locator(
        '[data-rd-keyboard-surface-template-body] button.n-key.ghost[data-key=""]',
      );
      assert.equal(await page.locator('[data-instance-id="keyboard"]').count(), 0);
      assert.equal(await page.locator('[data-rd-keyboard-surface-template][hidden]').count(), 1);
      assert.equal(await page.locator("[data-rd-keyboard-surface]").count(), 0);
      assert.ok((await real.count()) > 0, "SSR blueprint serves native buttons for physical keys");
      assert.ok((await spacers.count()) > 0, "SSR keeps authored spacer geometry");
      assert.equal(await real.first().isDisabled(), false);
      assert.equal(await real.first().getAttribute("tabindex"), "0");
      assert.equal(await real.first().getAttribute("aria-hidden"), "false");
      assert.equal(await spacers.first().isDisabled(), true);
      assert.equal(await spacers.first().getAttribute("tabindex"), "-1");
      assert.equal(await spacers.first().getAttribute("aria-hidden"), "true");
    } finally {
      await ssrContext.close();
    }
  });

  test("the keyboard stands on the canvas: served plate, finish, lens, and the key→Keys door", async () => {
    const page = await openBench();
    const keyboard = await ensureActiveKeyboard(page);
    assert.equal(
      (await bindExact(1, "A", "H", G915)).ok,
      true,
      "the keyboard plate is dressed only by this exact physical source",
    );
    const flashKb = (want) =>
      page.waitForFunction(
        (text) => document.querySelector(".rd-flash")?.textContent?.startsWith(text),
        want,
        { timeout: 20_000 },
      );
    await page.click('[data-nx="canvas-fit"]');
    await page.waitForTimeout(600);
    // The SERVED plate: six rows of real cells, bound caps wearing their
    // control shorts and ownership bands, the legend naming every player.
    assert.equal(await keyboard.locator(".n-kbrow").count(), 6);
    const bound = keyboard.locator(".n-kb .n-key.bound");
    await bound.first().waitFor({ state: "visible", timeout: 20_000 });
    assert.ok((await bound.count()) > 0, "the exact keyboard's bindings tint its caps");
    assert.ok(
      ((await bound.first().locator(".n-key-short").textContent()) ?? "").length > 0,
      "a bound cap says WHICH control drives it",
    );
    assert.ok(
      (await keyboard.locator(".n-legend .n-lgd").count()) > 0,
      "the legend chips name the players",
    );
    // Fit is deliberately a reading distance. At that scale the detailed
    // board remains legible but cannot pretend its tiny controls are honest
    // click targets; focusing the device returns to editing distance.
    assert.equal(await keyboard.getAttribute("data-keyboard-editable"), "false");
    await revealCanvasItem(page, G915_ID);
    await page.waitForFunction(
      (id) => document.querySelector(
        `.forma-canvas-stage > [data-instance-id="${id}"]`,
      )?.dataset.keyboardEditable === "true",
      G915_ID,
    );
    // The finish is the keyboard's own material — a click restamps the
    // widget and the preference survives in this browser.
    await keyboard.locator(
      '[data-nx="kb-theme"][data-keyboard-theme="retro-terminal"]',
    ).click();
    assert.equal(
      await keyboard.getAttribute("data-keyboard-theme"),
      "retro-terminal",
    );
    await keyboard.locator(
      '[data-nx="kb-theme"][data-keyboard-theme="carbon-forge"]',
    ).click();
    // The mute lens: one chip, one player's color — the same custom
    // property the nocturne sheet drives, written on the plate.
    await keyboard.locator('.n-legend [data-nx="legend-mute"][data-slot="1"]').click();
    assert.equal(
      await page.evaluate((id) =>
        document
          .querySelector(`[data-instance-id="${id}"] .n-kb`)
          ?.style.getPropertyValue("--kb1"),
        G915_ID),
      "var(--band-mute)",
    );
    await keyboard.locator('.n-legend [data-nx="legend-mute"][data-slot="1"]').click();
    assert.equal(
      await page.evaluate((id) =>
        document
          .querySelector(`[data-instance-id="${id}"] .n-kb`)
          ?.style.getPropertyValue("--kb1"),
        G915_ID),
      "",
    );
    // A plate key is the Keys tab's own door: clicking a bound cap opens
    // the inspector on the Keys view with that key's row revealed.
    const key = await bound.first().getAttribute("data-key");
    await bound.first().click();
    await page.waitForFunction(
      (wanted) =>
        document.querySelector(".rd-insp-vseg .vk")?.getAttribute("aria-pressed") === "true" &&
        document.querySelector(".rd-row-pulse")?.getAttribute("data-key") === wanted,
      key,
      { timeout: 20_000 },
    );
    assert.equal(
      await bound.first().evaluate((cell) => cell.tagName),
      "BUTTON",
      "every clickable plate key is a native keyboard control",
    );
    const ghostKeys = page.locator(
      `[data-instance-id="${G915_ID}"] button.n-key.ghost[data-key=""]`,
    );
    assert.ok((await ghostKeys.count()) > 0, "the served plate includes spacer cells");
    assert.equal(await ghostKeys.first().isDisabled(), true);
    assert.equal(await ghostKeys.first().getAttribute("tabindex"), "-1");
    assert.equal(await ghostKeys.first().getAttribute("aria-hidden"), "true");
    if ((await bound.count()) > 1) {
      const keyboardCell = bound.nth(1);
      const keyboardKey = await keyboardCell.getAttribute("data-key");
      await keyboardCell.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (wanted) => document.querySelector(".rd-row-pulse")?.getAttribute("data-key") === wanted,
        keyboardKey,
        { timeout: 20_000 },
      );
    }
    // NO board picker on this page (Victor's rule: a keyboard looks like a
    // keyboard — the plate is always the standard board picture here).
    assert.equal(
      await page.locator(".rd-boardpick:not(.rd-capture)").count(),
      0,
      "the Board menu stays removed",
    );
    // While playing — the staged input's capture behaviour (freeze / split
    // / take nothing), the 4460 device-section picker re-homed onto the
    // input's own widget. One staged edit; the daemon's answer re-marks.
    await page.click(".rd-capture .rd-boardpick-sum");
    assert.equal(
      await page.locator(".rd-capture .rd-boardpick-pop form").count(),
      3,
      "the daemon's three-answer roster",
    );
    await page
      .locator('.rd-capture form input[value="whole"]')
      .locator("..")
      .locator("button")
      .click();
    await flashKb("Capture behaviour updated.");
    await page.waitForFunction(
      () =>
        document
          .querySelector('.rd-capture form input[value="whole"]')
          ?.closest("form")
          ?.querySelector("button")
          ?.className.includes("on"),
      null,
      { timeout: 20_000 },
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("controller art is keyboard-operable and changing inspector tabs preserves keyboard UI state", async () => {
    const page = await openBench();
    await ensureActiveKeyboard(page);
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(1),
      { timeout: 20_000 },
    );

    // Put real preferences into the shared UI store through their own
    // controls, then add an unrelated sentinel. The pad-art door used to
    // replace this whole object with {inspTab}.
    await page.evaluate(() => {
      document
        .querySelector('[data-nx="kb-theme"][data-keyboard-theme="retro-terminal"]')
        ?.click();
      document.querySelector('[data-nx="kb-colors"]')?.click();
      const saved = JSON.parse(localStorage.getItem("ksx-redesign-ui") ?? "{}");
      saved.reviewSentinel = "keep";
      localStorage.setItem("ksx-redesign-ui", JSON.stringify(saved));
    });

    await revealCanvasItem(page, "ctrl-slot-1");
    const zone = page.locator(`${cardSel(1)} [data-rd-pad-action]`).first();
    const fn = await zone.getAttribute("data-fn");
    const art = page.locator(`${cardSel(1)} svg.rd-ctrlcard-art`);
    assert.equal(await art.getAttribute("aria-hidden"), null);
    assert.equal(await art.getAttribute("focusable"), null);
    assert.equal(await art.getAttribute("role"), "group");
    assert.ok((await art.getAttribute("aria-label"))?.trim());
    assert.equal(await zone.getAttribute("role"), "button");
    assert.equal(await zone.getAttribute("tabindex"), "0");
    assert.match((await zone.getAttribute("aria-label")) ?? "", /controller control$/);

    // Non-pointer activation must perform the selection work that a real
    // pointerdown normally performs. Start from the keyboard board so this test
    // cannot pass merely because the controller was already selected.
    await revealCanvasItem(page, G915_ID);
    assert.equal(
      await page
        .locator(`.forma-canvas-stage > [data-instance-id="${G915_ID}"]`)
        .getAttribute("aria-current"),
      "true",
    );
    assert.equal((await page.locator(".rd-insp-name").textContent())?.trim(), "Logitech G915 TKL");
    // The device-owned keyboard is a full board now. Frame the whole bench so
    // the controller runtime remains materialized while selection still rests
    // on that independent source board.
    await page.click('[data-nx="canvas-fit"]');
    await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
    await zone.focus();
    // An unchanged background repaint must not replace the focused SVG node.
    await page.waitForTimeout(2300);
    assert.equal(
      await zone.evaluate((control) => control === document.activeElement),
      true,
      "the two-second payload tick preserves focused controller art",
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      ({ card, fnName }) =>
        document.querySelector(card)?.getAttribute("aria-current") === "true" &&
        document.querySelector(".rd-insp-name")?.textContent?.includes("Player 1") &&
        document.querySelector(".rd-insp-vseg .vc")?.getAttribute("aria-pressed") === "true" &&
        document.querySelector(".rd-row-pulse")?.getAttribute("data-fn")?.toLowerCase() ===
          fnName?.toLowerCase(),
      { card: cardSel(1), fnName: fn },
      { timeout: 20_000 },
    );
    assert.equal(
      await zone.evaluate((control) => control === document.activeElement),
      true,
      "selecting the card and opening Controls preserves the activated SVG control's focus",
    );
    await zone.evaluate((control) => {
      control.addEventListener("click", (event) => {
        window.__ksxPadKeyboardShift = event.shiftKey;
      }, { capture: true, once: true });
    });
    await page.keyboard.press("Shift+Enter");
    assert.equal(
      await page.evaluate(() => window.__ksxPadKeyboardShift),
      true,
      "keyboard activation preserves the modifier contract of Shift+click",
    );
    await page.waitForFunction(
      (fnName) => {
        const pulse = document.querySelector(".rd-row-pulse");
        return pulse?.getAttribute("data-fn")?.toLowerCase() === fnName?.toLowerCase();
      },
      fn,
      { timeout: 20_000 },
    );
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("ksx-redesign-ui") ?? "{}")
    );
    assert.equal(stored.kbTheme, "retro-terminal");
    assert.equal(stored.kbSolo, true);
    assert.equal(stored.reviewSentinel, "keep");
    assert.equal(stored.inspTab, "controls");

    // Leave the persistent browser context in its baseline finish/lens.
    await page.evaluate(() => {
      document
        .querySelector('[data-nx="kb-theme"][data-keyboard-theme="carbon-forge"]')
        ?.click();
      document.querySelector('[data-nx="kb-colors"]')?.click();
      const saved = JSON.parse(localStorage.getItem("ksx-redesign-ui") ?? "{}");
      delete saved.reviewSentinel;
      localStorage.setItem("ksx-redesign-ui", JSON.stringify(saved));
    });
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("selecting a card serves ITS panel; the row verbs edit the draft; ✕ offers the undo", async () => {
    const page = await openBench();
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(1),
      { timeout: 20_000 },
    );
    const flashIs = (want) =>
      page.waitForFunction(
        (text) => document.querySelector(".rd-flash")?.textContent?.startsWith(text),
        want,
        { timeout: 20_000 },
      );

    // Earlier tests leave the camera where their own gestures ended. Use the
    // real minimap navigation path so this card is both visible and at the
    // semantic editing tier before opening its panel.
    await revealCanvasItem(page, "ctrl-slot-1");
    // Selecting the card opens the inspector with the transplanted nocturne
    // panel — six groups, the meta strip, the SOCD editor — and the slot
    // rides the URL (the nocturne selection door), so a reload keeps it.
    await page.click(`${cardSel(1)} .rd-ctrlcard-slot`);
    // The tab choice persists per browser (the keyboard test may have left
    // Keys showing) — this test speaks for the Controls reading.
    await page.waitForFunction(
      () => Boolean(document.querySelector(".rd-insp-vseg .vc")),
      null,
      { timeout: 20_000 },
    );
    if (
      (await page.locator(".rd-insp-vseg .vc").getAttribute("aria-pressed")) !== "true"
    ) {
      await page.click(".rd-insp-vseg .vc");
    }
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-insp-body .n-bindg-head").length === 6,
      null,
      { timeout: 20_000 },
    );
    assert.equal(
      await page.evaluate(() => new URLSearchParams(window.location.search).get("slot")),
      "1",
    );
    assert.equal(
      (await page.locator(".rd-insp-body .n-socd-lab").textContent())?.trim(),
      "Opposites — P1",
    );
    const servedSocd = await page.evaluate(async () =>
      (await (await fetch("/api/redesign?slot=1")).json()).controllers.panel.socd_current
    );
    assert.equal(
      await page.getByLabel("Opposites — P1").inputValue(),
      servedSocd,
      "the editor starts on the effective served policy instead of the roster's first option",
    );
    assert.equal(
      await page.getByLabel("Opposites — P1").count(),
      1,
      "the visible SOCD label names its select",
    );

    // The destructive bulk action is a consequence disclosure, not a submit
    // parked beside Map all. Opening and closing it changes nothing.
    let clearAllPosts = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/redesign/bind/clear-all"
      ) clearAllPosts += 1;
    });
    const clearAllDisclosure = page.locator(".rd-insp-ctrlverbs details.n-clearall");
    assert.equal(await clearAllDisclosure.evaluate((details) => details.open), false);
    await clearAllDisclosure.locator("summary").click();
    assert.match(
      (await clearAllDisclosure.locator(".n-foot").textContent()) ?? "",
      /direct key binding.*macro trigger.*steps remain/s,
    );
    assert.equal(
      (await clearAllDisclosure.locator('button[type="submit"]').textContent())?.trim(),
      "Unbind this keyboard’s keys",
    );
    await clearAllDisclosure.locator("summary").focus();
    await page.waitForTimeout(2300);
    assert.equal(
      await clearAllDisclosure.evaluate((details) => details.open),
      true,
      "an unchanged payload does not collapse the consequence disclosure",
    );
    assert.equal(
      await clearAllDisclosure.locator("summary").evaluate((summary) =>
        summary === document.activeElement
      ),
      true,
      "the disclosure keeps keyboard focus across the poll",
    );
    assert.equal(clearAllPosts, 0, "reading the consequence cannot submit it");
    await clearAllDisclosure.locator("summary").click();
    const boundRows = page.locator(".rd-insp-body details.n-bind.on");
    assert.ok((await boundRows.count()) > 0, "the layout bound rows to edit");
    const fn = await boundRows.first().getAttribute("data-fn");
    const row = () => page.locator(`.rd-insp-body details.n-bind[data-fn="${fn}"]`);

    // Press behaviour: the row's Toggle pill is a REAL form twin of the
    // re-homed verb — the outcome is nocturne's sentence, and the repaint
    // shows the latch on the row badge.
    await row().locator(".n-bind-label").click();
    await row().locator('button[title="A press holds until the next press"]').click();
    await flashIs("Press behaviour updated.");
    await page.waitForFunction(
      (fnName) =>
        document
          .querySelector(`.rd-insp-body details.n-bind[data-fn="${fnName}"] .n-rowbadge`)
          ?.textContent?.includes("Toggle"),
      fn,
      { timeout: 20_000 },
    );

    // Auto-fire: a preset rate lands and joins the badge. The row is STILL
    // open — a repaint preserves the reader's place (open rows and scroll
    // survive every refresh), so no second click to reopen it.
    assert.equal(
      await row().evaluate((r) => r.open),
      true,
      "the edited row stays open across the verb's repaint",
    );
    await row().locator('button[title="Standard — 10 presses a second"]').click();
    await flashIs("Auto-fire updated");
    await page.waitForFunction(
      (fnName) =>
        document
          .querySelector(`.rd-insp-body details.n-bind[data-fn="${fnName}"] .n-rowbadge`)
          ?.textContent?.includes("10/s"),
      fn,
      { timeout: 20_000 },
    );

    // The row's own ✕: back to unbound — the row leaves the bound list and
    // the control reappears as a free chip in its group's strip.
    await row().locator('button[aria-label="Unbind this control"]').click();
    await flashIs("Draft updated.");
    await page.waitForFunction(
      (fnName) =>
        !document.querySelector(`.rd-insp-body details.n-bind[data-fn="${fnName}"]`) &&
        Boolean(document.querySelector(`.rd-insp-body .n-ctlstrip [data-fn="${fnName}"]`)),
      fn,
      { timeout: 20_000 },
    );

    // The opposite-directions editor writes through the served roster.
    const socdValue = await page
      .locator(".rd-insp-body .n-socd-sel option")
      .evaluateAll((options, current) =>
        options.map((option) => option.value).find((value) => value !== current) ?? current,
      servedSocd);
    await page.selectOption(".rd-insp-body .n-socd-sel", socdValue);
    await page.locator(".rd-insp-body .n-socd-sel").focus();
    await page.waitForTimeout(2300);
    assert.equal(
      await page.locator(".rd-insp-body .n-socd-sel").inputValue(),
      socdValue,
      "an unchanged payload does not reset an unsubmitted policy choice",
    );
    assert.equal(
      await page.locator(".rd-insp-body .n-socd-sel").evaluate((select) =>
        select === document.activeElement
      ),
      true,
      "the SOCD select keeps focus across the poll",
    );
    await page.locator(".rd-insp-body .n-socd-set").click();
    await flashIs("Draft updated.");

    // The Keys tab — 4460's By-key reading of the same facts: every bound
    // key with its fan-out, the still-free keys below, and the row ✕ that
    // takes a key away from everything it drives (a re-homed real verb).
    await page.click(".rd-insp-vseg .n-vseg-btn.vk");
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-insp-krows .n-krow").length > 0,
      null,
      { timeout: 20_000 },
    );
    const friendlyControl = page.locator('.rd-insp-body [data-key="LeftControl"]').first();
    assert.equal(await friendlyControl.getAttribute("data-key"), "LeftControl");
    assert.match(
      (await friendlyControl.textContent()) ?? "",
      /Ctrl/,
      "human-facing chips use the keyboard cap vocabulary",
    );
    assert.doesNotMatch(
      (await page.locator(".rd-insp-body").textContent()) ?? "",
      /OpenBracketBrace|SingleDoubleQuote|ForwardSlashQuestionMark/,
      "backend key identifiers do not leak into visible copy",
    );
    const keyCount = await page.locator(".rd-insp-krows .n-krow").count();
    const victim = await page
      .locator(".rd-insp-krows .n-krow")
      .first()
      .getAttribute("data-key");
    await page
      .locator(`.rd-insp-krows .n-krow[data-key="${victim}"] .n-krow-clear`)
      .click();
    await flashIs("That key is free again");
    await page.waitForFunction(
      ([key, before]) =>
        !document.querySelector(`.rd-insp-krows .n-krow[data-key="${key}"]`) &&
        document.querySelectorAll(".rd-insp-krows .n-krow").length === before - 1,
      [victim, keyCount],
      { timeout: 20_000 },
    );
    // A key row's "drives" door jumps to the Controls view and opens the
    // named row — and clicking a control ON THE PAD ART does the same (the
    // 4460 pointer enhancement).
    await page.locator(".rd-insp-krows .n-krow").first().locator(".n-krow-tg").click();
    await page.waitForFunction(
      () => Boolean(document.querySelector(".rd-insp-body details.n-bind[open]")),
      null,
      { timeout: 20_000 },
    );
    const zoneFn = await page.evaluate(() => {
      const zone = document.querySelector(
        '.forma-canvas-stage [data-instance-id^="ctrl-slot-"] .rd-ctrlcard-artwrap [data-fn]',
      );
      return zone?.getAttribute("data-fn")?.split(/\s+/)[0] ?? "";
    });
    assert.ok(zoneFn, "the clone's zones carry their mapper functions");

    // ✕ remove offers the server-held undo; Undo restores the controller
    // with its bindings (nocturne's chip contract on this page's stash).
    await revealCanvasItem(page, "ctrl-slot-1");
    await page.locator(`${cardSel(1)} .rd-ctrlverb-danger`).click();
    await page.waitForFunction(
      () => {
        const chip = document.querySelector("form.rd-undochip");
        return chip && !chip.classList.contains("none");
      },
      null,
      { timeout: 20_000 },
    );
    assert.match(
      (await page.locator("form.rd-undochip .n-undo-lab").textContent()) ?? "",
      /removed/,
    );
    await page.locator("form.rd-undochip .n-undo-btn").click();
    await flashIs("Controller restored with its bindings.");
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.forma-canvas-stage [data-instance-id^="ctrl-slot-"]')
          .length === 1 &&
        document.querySelector("form.rd-undochip")?.classList.contains("none"),
      null,
      { timeout: 20_000 },
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});

describe("the mapper on the workbench", () => {
  // The fixture daemon's learner INSTANT-HITS the key G (macro_fixture's
  // scripted gesture), so a cross-slot G planted by this setup guarantees
  // every learned hit raises the conflict QUESTION — the protocol's whole
  // point. State is built through the same doors the page uses, so these
  // tests hold whatever the earlier suites left behind.
  const apiBind = (slot, fn, key, force) => bindExact(slot, fn, key, IPAC, force);
  let s1;
  let s2;

  before(async () => {
    let payload = await api();
    if (payload.controllers.pads.length < 2) {
      await fetch(`${BASE}/redesign/controller`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "persona=xbox360&preset=Mapper+P2&layout=keyboard-2p",
        redirect: "manual",
      });
      payload = await api();
    }
    const pads = payload.controllers.pads;
    assert.ok(pads.length >= 2, "two seats for the cross-slot question");
    s1 = String(pads[0].slot);
    s2 = String(pads[1].slot);
    // Known ground: A on seat one wears H, and G lives on the OTHER seat —
    // the learner's scripted G is then always a cross-slot question here.
    assert.equal((await apiBind(s1, "A", "H", true)).ok, true);
    assert.equal((await apiBind(s2, "B", "G", true)).ok, true);
  });

  async function openPanel(page, slot) {
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(slot),
      { timeout: 20_000 },
    );
    await revealCanvasItem(page, `ctrl-slot-${slot}`);
    await page.click(`${cardSel(slot)} .rd-ctrlcard-slot`);
    await page.waitForFunction(
      () => Boolean(document.querySelector(".rd-insp-vseg .vc")),
      null,
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

  const dialogShown = (page) =>
    page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display !== "none",
      null,
      { timeout: 20_000 },
    );
  const dialogGone = (page) =>
    page.waitForFunction(
      () => getComputedStyle(document.querySelector(".rd-confdlg")).display === "none",
      null,
      { timeout: 20_000 },
    );

  test("learn: the chip arms, the hit raises the cross-slot question, Esc declines, Use-here-too shares", async () => {
    const page = await openBench();
    await ensureActiveEncoder(page);
    await openPanel(page, s1);
    const chipSel = '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]';
    const before = (await page.locator(chipSel).textContent())?.trim();

    // ONE click arms; the scripted hit lands in ~33ms and the question opens
    // instead of a silent cross-slot grab (fail-closed, nocturne's rule).
    await page.locator(chipSel).click();
    await dialogShown(page);
    assert.match(
      (await page.locator(".rd-confdlg .nd-title").textContent()) ?? "",
      /Give G to A too\?/,
    );
    assert.match(
      (await page.locator(".rd-confdlg .nd-lede").textContent()) ?? "",
      /already controls/,
      "the lede names what the key drives today",
    );

    // Esc declines: the dialog closes and NOTHING was written.
    await page.keyboard.press("Escape");
    await dialogGone(page);
    assert.equal((await page.locator(chipSel).textContent())?.trim(), before, "declined = unchanged");

    // Ask again and confirm: sharing binds here while the other seat keeps
    // its key, and the flash is the row's own sentence.
    await page.locator(chipSel).click();
    await dialogShown(page);
    await page.click('.rd-confdlg [data-nx="rd-conf-force"]');
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent?.trim() === "G",
      chipSel,
      { timeout: 20_000 },
    );
    assert.match(
      (await page.locator(".rd-flash").textContent()) ?? "",
      /A is now G/,
    );
    const other = (await api()).controllers.pads.find((p) => String(p.slot) === s2);
    assert.ok(
      exactSource(other, IPAC).controls.find((c) => c.function === "B").keys.includes("G"),
      "the other seat KEPT its key — share, never steal",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("clicking the control being recorded cancels the gesture (the PadForge toggle)", async () => {
    const page = await openBench();
    await ensureActiveEncoder(page);
    await openPanel(page, s1);
    // Two clicks inside ONE task: the second lands while the first's arm is
    // still in flight — the toggle branch must retire it silently, and the
    // superseded daemon answer must die without a dialog.
    await page.evaluate(() => {
      const chip = document.querySelector(
        '.rd-insp-body details.n-bind[data-fn="A"] [data-nx="chip-learn"]',
      );
      const click = () =>
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      click();
      click();
    });
    await page.waitForTimeout(600);
    const state = await page.evaluate(() => ({
      banner: getComputedStyle(document.querySelector(".rd-learnbar")).display,
      dialog: getComputedStyle(document.querySelector(".rd-confdlg")).display,
    }));
    assert.deepEqual(state, { banner: "none", dialog: "none" });
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("assign: a free key goes in hand and the pad art is the picker", async () => {
    const page = await openBench();
    await ensureActiveEncoder(page);
    await openPanel(page, s1);
    await page.click(".rd-insp-vseg .vk");
    await page.waitForFunction(
      () => document.querySelectorAll(".rd-insp-krows .n-krow").length > 0,
      null,
      { timeout: 20_000 },
    );
    const key = await page.evaluate(() =>
      [...document.querySelectorAll('.rd-insp-body [data-nx="rd-akey"]')]
        .map((n) => n.getAttribute("data-key"))
        .find((k) => /^[A-Z]$/.test(k ?? "")),
    );
    assert.ok(key, "a free letter key to take in hand");
    await page.locator(`.rd-insp-body [data-nx="rd-akey"][data-key="${key}"]`).click();
    await page.waitForFunction(
      () => document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 20_000 },
    );
    assert.match(
      (await page.locator(".rd-learn-line").textContent()) ?? "",
      new RegExp(`Click a control on the pad — ${key} replaces its binding`),
    );
    // A REAL pointer click on the silhouette's X face button resolves it.
    await page.locator(`${cardSel(Number(s1))} svg [data-fn="x"]`).first().click();
    await page.waitForFunction(
      () => !document.querySelector(".rd-learnbar")?.classList.contains("listen"),
      null,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      (want) => document.querySelector(".rd-flash")?.textContent?.includes(want),
      `X is now ${key}.`,
      { timeout: 20_000 },
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the cords: Paths scopes the flow layer and prices what it drew", async () => {
    const page = await openBench();
    await ensureActiveKeyboard(page);
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.dataset.canvasX !== undefined,
      cardSel(Number(s1)),
      { timeout: 20_000 },
    );
    // Off is the resting truth: the layers hold no drawing.
    assert.equal(
      await page.evaluate(() => document.querySelectorAll("#n-mapping-paths path").length),
      0,
    );
    await page.selectOption('[data-nx="rd-mapping-paths"]', "all");
    await page.waitForFunction(
      () => document.querySelectorAll("#n-mapping-paths path").length > 0,
      null,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => /^\d+$/.test(document.querySelector(".rd-pathcount")?.textContent?.trim() ?? ""),
      null,
      { timeout: 20_000 },
    );
    const drawn = await page.evaluate(() => ({
      paths: document.querySelectorAll("#n-mapping-paths path").length,
      count: Number(document.querySelector(".rd-pathcount")?.textContent),
    }));
    assert.ok(drawn.count > 0, "the counter prices the cords");
    assert.ok(drawn.paths >= drawn.count, "every priced cord is drawn");
    await page.selectOption('[data-nx="rd-mapping-paths"]', "off");
    await page.waitForFunction(
      () => document.querySelectorAll("#n-mapping-paths path").length === 0,
      null,
      { timeout: 20_000 },
    );
    // The chosen mode is DURABLE: a camera persist rebuilds the prefs
    // struct and a reload reads it back — each writer once dropped the
    // mapping fields, so a camera nudge silently snapped the select to Off
    // and the cords vanished on the next repaint.
    await page.selectOption('[data-nx="rd-mapping-paths"]', "all");
    await page.waitForFunction(
      () => document.querySelectorAll("#n-mapping-paths path").length > 0,
      null,
      { timeout: 20_000 },
    );
    await page.click('button.n-autobtn[data-nx="canvas-fit"]:not(.rd-menu-row)');
    await page.waitForFunction(
      () => !document.querySelector(".is-camera-animating"),
      null,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
      null,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[data-nx="rd-mapping-paths"]')?.value === "all" &&
        document.querySelectorAll("#n-mapping-paths path").length > 0,
      null,
      { timeout: 20_000 },
    );
    // Leave the canvas the way this test found it.
    await page.selectOption('[data-nx="rd-mapping-paths"]', "off");
    await page.waitForFunction(
      () => document.querySelectorAll("#n-mapping-paths path").length === 0,
      null,
      { timeout: 20_000 },
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("auto-map walks the unbound controls; confirm binds, decline skips, the run reports", async () => {
    // Known walk: exactly the two right-stick horizontals are unbound. The
    // earlier suites leave arbitrary holes, so this dresses every OTHER
    // control (same-slot key sharing is allowed — H all round) and clears
    // the two the walk should visit.
    for (const fn of ["rx.min", "rx.max"]) {
      await clearExact(s1, fn, IPAC);
    }
    for (;;) {
      const pad = (await api()).controllers.pads.find((p) => String(p.slot) === s1);
      const hole = exactSource(pad, IPAC).controls.find(
        (c) => c.keys.length === 0 && c.function !== "rx.min" && c.function !== "rx.max",
      );
      if (!hole) break;
      assert.equal(
        (await apiBind(s1, hole.function, "H", true)).ok,
        true,
        `dressing ${hole.function}`,
      );
    }
    const fresh = (await api()).controllers.pads.find((p) => String(p.slot) === s1);
    const unbound = exactSource(fresh, IPAC).controls
      .filter((c) => c.keys.length === 0)
      .map((c) => c.function);
    assert.deepEqual(unbound, ["rx.min", "rx.max"], "the walk's steps are known ground");

    const page = await openBench();
    await ensureActiveEncoder(page);
    await openPanel(page, s1);
    await page.click('[data-nx="rd-automap"]');
    // Step 1 instant-hits G → the cross-slot question. Confirm: it binds.
    await dialogShown(page);
    assert.match(
      (await page.locator(".rd-confdlg .nd-title").textContent()) ?? "",
      /Give G to RS ←/,
    );
    await page.click('.rd-confdlg [data-nx="rd-conf-force"]');
    // Step 2's question. DECLINE: the walk skips it and moves on — and with
    // no steps left, the run reports exactly what it bound.
    await dialogShown(page);
    assert.match(
      (await page.locator(".rd-confdlg .nd-title").textContent()) ?? "",
      /Give G to RS →/,
    );
    await page.click('.rd-confdlg [data-nx="rd-conf-cancel"]');
    await dialogGone(page);
    await page.waitForFunction(
      () =>
        document.querySelector(".rd-flash")?.textContent?.includes(
          "Auto-map finished — 1 control bound.",
        ),
      null,
      { timeout: 20_000 },
    );
    const end = (await api()).controllers.pads.find((p) => String(p.slot) === s1);
    const endSource = exactSource(end, IPAC);
    assert.deepEqual(
      endSource.controls.find((c) => c.function === "rx.min").keys,
      ["G"],
      "the confirmed step wears the shared key",
    );
    assert.deepEqual(
      endSource.controls.find((c) => c.function === "rx.max").keys,
      [],
      "the declined step stays unbound",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  // ── Macros: the lifecycle rows, the step editor, and the trigger's learn ──

  test("the macro lifecycle verbs are real forms on this page's doors", async () => {
    const page = await openBench();
    await openPanel(page, s1);
    await page.waitForFunction(
      () => Boolean(document.querySelector(".rd-insp-body .n-macrosec")),
      null,
      { timeout: 20_000 },
    );

    // New macro… through the section's own form.
    await page.evaluate(() => {
      document.querySelector(".n-macrosec .n-macnew")?.setAttribute("open", "");
    });
    await page.fill(".n-macrosec .n-macnewin", "probe-combo");
    await page.click('.n-macrosec [data-rd-form="macro-new"] button[type="submit"]');
    await page.waitForFunction(
      () =>
        Boolean(
          document.querySelector('.n-macrosec details[data-fn="macro.probe-combo"]'),
        ),
      null,
      { timeout: 20_000 },
    );
    assert.match(
      (await page.locator(".rd-flash").textContent()) ?? "",
      /Macro created with one empty step/,
    );

    // Disable — the toggle twin: the row says so and keeps its steps.
    const row = '.n-macrosec details[data-fn="macro.probe-combo"]';
    await page.evaluate((sel) => document.querySelector(sel)?.setAttribute("open", ""), row);
    const toggleLabel = (await page
      .locator(`${row} [data-rd-form="macro-toggle"] button`)
      .textContent())?.trim();
    await page.click(`${row} [data-rd-form="macro-toggle"] button`);
    await page.waitForFunction(
      (args) =>
        document
          .querySelector(`${args.row} [data-rd-form="macro-toggle"] button`)
          ?.textContent?.trim() !== args.was,
      { row, was: toggleLabel },
      { timeout: 20_000 },
    );

    // Delete… asks in place, then removes the row.
    await page.evaluate((sel) => {
      const details = document.querySelector(sel);
      details?.setAttribute("open", "");
      details?.querySelector(".n-bdel")?.setAttribute("open", "");
    }, row);
    await page.click(`${row} [data-rd-form="macro-delete"] button`);
    await page.waitForFunction(
      () => !document.querySelector('.n-macrosec details[data-fn="macro.probe-combo"]'),
      null,
      { timeout: 20_000 },
    );
    assert.match(
      (await page.locator(".rd-flash").textContent()) ?? "",
      /Macro removed from this draft/,
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("the step editor: acts are the server's answer, the draft wins, Save writes", async () => {
    // A macro of known shape, through the same verb the CLI uses.
    const source = await sourceAuthority(s1, IPAC);
    const seeded = await (
      await fetch(`${BASE}/api/macro/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "stage",
          slot: Number(s1),
          expected_device: IPAC,
          expected_target_revision: source.revision,
          preset: source.preset,
          name: "probe-roll",
          steps: [{ hold: ["A"], ms: 50 }],
        }),
      })
    ).json();
    assert.equal(seeded.ok, true, JSON.stringify(seeded));

    const page = await openBench();
    await openPanel(page, s1);
    await page.waitForFunction(
      () => Boolean(document.querySelector('.n-macrosec details[data-fn="macro.probe-roll"]')),
      null,
      { timeout: 20_000 },
    );

    // Edit steps… is the ?macro= door, ENHANCED: the URL merges, the served
    // dialog paints, and the canvas never reloads.
    const row = '.n-macrosec details[data-fn="macro.probe-roll"]';
    await page.evaluate((sel) => document.querySelector(sel)?.setAttribute("open", ""), row);
    await page.locator(`${row} a.n-bbtn-link`).click();
    await page.waitForFunction(
      () =>
        !document.querySelector(".rd-macdlg")?.classList.contains("none") &&
        document.querySelectorAll(".rd-macdlg [data-maccell]").length > 0,
      null,
      { timeout: 20_000 },
    );
    assert.equal(
      (await page.locator(".rd-macdlg .nd-title").textContent())?.trim(),
      "probe-roll",
    );
    assert.ok(
      (await page.evaluate(() => window.location.search)).includes("macro=probe-roll"),
      "the dialog's open state IS the URL",
    );

    // ONE act: the diagonal pick writes the PAIR, and the server says so.
    await page.click('.rd-macdlg [data-maccell="0|diag:dpad:dr"]');
    await page.waitForFunction(
      () => document.querySelector(".rd-macdlg .n-macdirty")?.textContent === "Unsaved changes",
      null,
      { timeout: 20_000 },
    );
    assert.match(
      (await page.locator(".rd-macdlg .n-macsay-line").textContent()) ?? "",
      /dpad\.down \+ dpad\.right/,
      "the act's teaching names both halves",
    );

    // Escape warns about unsaved work FIRST; the work survives.
    await page.keyboard.press("Escape");
    assert.match(
      (await page.locator(".rd-macdlg .n-macsay-line").textContent()) ?? "",
      /unsaved changes/,
    );

    // Save writes the WHOLE table; the staged truth carries the pair.
    await page.click('.rd-macdlg [data-macact="save"]');
    await page.waitForFunction(
      () => (document.querySelector(".rd-macdlg .n-macsay-line")?.textContent ?? "").includes("Saved"),
      null,
      { timeout: 20_000 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelector(".rd-macdlg")?.classList.contains("none"),
      null,
      { timeout: 20_000 },
    );
    const truth = await (
      await fetch(
        `${BASE}/api/redesign?slot=${s1}&source=${encodeURIComponent(IPAC)}&macro=probe-roll`,
      )
    ).json();
    assert.deepEqual(
      truth.controllers.mac.table.steps[0].hold,
      ["A", "dpad.down", "dpad.right"],
      "the saved table holds what the roll showed",
    );
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });

  test("a macro trigger key binds through the SAME learn flow as any control", async () => {
    const page = await openBench();
    await ensureActiveEncoder(page);
    await openPanel(page, s1);
    await page.waitForFunction(
      () => Boolean(document.querySelector('.n-macrosec details[data-fn^="macro."] [data-nx="chip-learn"]')),
      null,
      { timeout: 20_000 },
    );
    await page.locator('.n-macrosec details[data-fn^="macro."] [data-nx="chip-learn"]').first().click();
    // The scripted hit is G, and G lives on the other seat — the SAME
    // cross-slot question any control's learn raises.
    await dialogShown(page);
    assert.match(
      (await page.locator(".rd-confdlg .nd-title").textContent()) ?? "",
      /Give G to /,
    );
    await page.keyboard.press("Escape");
    await dialogGone(page);
    assert.deepEqual(page.ksxNoise, [], "the page must stay error-free");
    await page.close();
  });
});
