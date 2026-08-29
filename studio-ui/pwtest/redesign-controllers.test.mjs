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
    // it the way a user would before pressing the ghost's own ✕, and frame
    // the world: the pad-sized cards (440-wide, the real silhouettes) home
    // onto a larger grid than the old text mocks, so a fresh ghost can
    // mount outside the current camera.
    if (await page.locator(".rd-inspector:not([hidden])").count()) {
      await page.locator('[data-nx="rd-insp-close"]').click();
    }
    await page.click('[data-nx="canvas-fit"]');
    await page.waitForTimeout(500);
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

  test("the keyboard stands on the canvas: served plate, finish, lens, and the key→Keys door", async () => {
    const page = await openBench();
    const flashKb = (want) =>
      page.waitForFunction(
        (text) => document.querySelector(".rd-flash")?.textContent?.startsWith(text),
        want,
        { timeout: 20_000 },
      );
    await page.waitForFunction(
      () => document.querySelector('[data-instance-id="keyboard"]')?.dataset.canvasX !== undefined,
      null,
      { timeout: 20_000 },
    );
    await page.click('[data-nx="canvas-fit"]');
    await page.waitForTimeout(600);
    // The SERVED plate: six rows of real cells, bound caps wearing their
    // control shorts and ownership bands, the legend naming every player.
    assert.equal(await page.locator('.forma-canvas-stage > [data-instance-id="keyboard"] .n-kbrow').count(), 6);
    const bound = page.locator('.forma-canvas-stage > [data-instance-id="keyboard"] .n-kb .n-key.bound');
    assert.ok((await bound.count()) > 0, "the fixture bindings tint their caps");
    assert.ok(
      ((await bound.first().locator(".n-key-short").textContent()) ?? "").length > 0,
      "a bound cap says WHICH control drives it",
    );
    assert.ok(
      (await page.locator('.forma-canvas-stage > [data-instance-id="keyboard"] .n-legend .n-lgd').count()) > 0,
      "the legend chips name the players",
    );
    // The finish is the keyboard's own material — a click restamps the
    // widget and the preference survives in this browser.
    await page.click('[data-nx="kb-theme"][data-keyboard-theme="retro-terminal"]');
    assert.equal(
      await page
        .locator('.forma-canvas-stage > [data-instance-id="keyboard"]')
        .getAttribute("data-keyboard-theme"),
      "retro-terminal",
    );
    await page.click('[data-nx="kb-theme"][data-keyboard-theme="carbon-forge"]');
    // The mute lens: one chip, one player's color — the same custom
    // property the nocturne sheet drives, written on the plate.
    await page.click('.n-legend [data-nx="legend-mute"][data-slot="1"]');
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[data-instance-id="keyboard"] .n-kb')
          ?.style.getPropertyValue("--kb1"),
      ),
      "var(--band-mute)",
    );
    await page.click('.n-legend [data-nx="legend-mute"][data-slot="1"]');
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('[data-instance-id="keyboard"] .n-kb')
          ?.style.getPropertyValue("--kb1"),
      ),
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
    // The board picker offers the served roster and the write ROUND-TRIPS:
    // the fixture remembers the choice like the real store (the in-memory
    // board cell), so the row comes back marked — never a dead control.
    await page.click(".rd-boardpick:not(.rd-capture) .rd-boardpick-sum");
    assert.ok(
      (await page.locator(".rd-boardpick:not(.rd-capture) .rd-boardpick-pop form").count()) >= 2,
      "the roster serves follow-hardware and the standard board",
    );
    await page
      .locator('.rd-boardpick:not(.rd-capture) form input[value="qwerty-104"]')
      .locator("..")
      .locator("button")
      .click();
    await flashKb("Board updated.");
    await page.waitForFunction(
      () =>
        document
          .querySelector('.rd-boardpick:not(.rd-capture) form input[value="qwerty-104"]')
          ?.closest("form")
          ?.querySelector("button")
          ?.className.includes("on"),
      null,
      { timeout: 20_000 },
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

    // Frame the world first: earlier tests in this shared-fixture suite
    // left the camera where THEIR gestures ended, and a canvas item outside
    // the viewport cannot be clicked (the engine transforms, nothing
    // scrolls). The pill's Fit verb needs no focus scope, unlike the "1"
    // shortcut.
    await page.click('[data-nx="canvas-fit"]');
    await page.waitForTimeout(600);
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
      .last()
      .getAttribute("value");
    await page.selectOption(".rd-insp-body .n-socd-sel", socdValue);
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
