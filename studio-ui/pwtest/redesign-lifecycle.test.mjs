// End-to-end product contract for /redesign's final cutover-critical block:
// draft/session separation, structural Apply recovery, restore points, and
// the real SSE door. This drives the actual Forma island and Rust router.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_LIFECYCLE_PORT ?? 4544);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/redesign`);
      if (response.ok) return;
    } catch {
      // The fixture is still linking or starting.
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE}`);

  const built = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the redesign lifecycle fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], {
    cwd: repoRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      KSX_FIXTURE_SESSION: "running",
      KSX_FIXTURE_LIVE: "1",
      KSX_FIXTURE_APPLY: "restart",
    },
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "redesign lifecycle fixture");
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
  await page.goto(`${BASE}/redesign?slot=1`, { waitUntil: "domcontentloaded" });
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

async function clickAction(page, kind) {
  const button = page.locator(
    `[data-rd-form="${kind}"] button[type="submit"]:visible`,
  ).first();
  await assert.doesNotReject(() => button.click());
}

async function openSetup(page) {
  const details = page.locator(".rd-setupd");
  if (!(await details.evaluate((element) => element.open))) {
    await page.locator(".rd-setup-sum").click();
  }
}

async function openControllerInspector(page, slot = 1) {
  const card = page.locator(`.forma-canvas-stage > [data-instance-id="ctrl-slot-${slot}"]`);
  await card.waitFor({ state: "visible" });
  await card.locator(".rd-ctrlcard-name").click();
  await page.locator('[data-rd-form="controller-socd"]').waitFor({ state: "visible" });
}

async function applyButtonIsReady(page) {
  return page.locator('[data-rd-form="apply"]').evaluateAll((forms) =>
    forms.some((form) => {
      const button = form.querySelector("button");
      return !form.classList.contains("none") && button && !button.disabled;
    }),
  );
}

describe("redesign lifecycle shell", { concurrency: false }, () => {
  test("the real workbench separates draft, session, recovery and live feedback", async () => {
    const page = await openBench();

    await page.waitForFunction(
      () => ["active", "degraded"].includes(
        document.querySelector("[data-forma-island]")?.dataset.rdLiveState ?? "",
      ) && Boolean(document.querySelector("[data-rd-live-stats]")?.textContent?.startsWith("Live")) &&
        Boolean(document.querySelector("[data-key].live, [data-fn].live")),
      null,
      { timeout: 20_000 },
    );
    assert.match(await page.locator("[data-rd-live-stats]").textContent(), /^Live/);
    assert.match(await page.locator(".rd-setup-compact").textContent(), /Playing/);

    // Stop is always its own escape verb. The scripted live feed must lose
    // its paint as soon as the served session says idle.
    await clickAction(page, "stop");
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-rd-form="play"]')).some(
        (form) => !form.classList.contains("none"),
      ) && document.querySelector('[data-rd-form="stop"]')?.classList.contains("none"),
    );
    assert.match(await page.locator(".rd-flash").textContent(), /Play stopped/);
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.dataset.rdLiveState === "inactive",
    );

    // A stopped exact-device session deliberately fails closed until the
    // operator acknowledges the recovery path and prepares that same device.
    await openSetup(page);
    const prepare = page.locator('[data-rd-form="capture-prepare"]');
    await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    await prepare.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-rd-form="play"] button')).some(
        (button) => !button.disabled && button.offsetParent !== null,
      ),
      null,
      { timeout: 20_000 },
    );
    assert.match(await page.locator(".rd-flash").textContent(), /prepared/i);
    await page.locator(".rd-setup-sum").click();

    const draftBeforePlay = (await page.locator(".rd-draft-label").textContent())?.trim();
    assert.match(draftBeforePlay ?? "", /Unsaved|Loaded|Saved setup/);
    await clickAction(page, "play");
    await page.waitForFunction(
      () => !document.querySelector('[data-rd-form="stop"]')?.classList.contains("none"),
    );
    assert.equal(
      (await page.locator(".rd-draft-label").textContent())?.trim(),
      draftBeforePlay,
      "Play must not silently save the draft",
    );

    // A same-structure edit takes the in-place Apply path. It updates the
    // running revision but deliberately leaves disk divergence untouched.
    await openControllerInspector(page);
    const socd = page.locator('[data-rd-form="controller-socd"]');
    const socdSelect = socd.locator('select[name="socd"]');
    const currentSocd = await socdSelect.inputValue();
    const nextSocd = await socdSelect.locator("option").evaluateAll(
      (options, current) => options.find((option) => option.value !== current)?.value ?? "",
      currentSocd,
    );
    assert.notEqual(nextSocd, "", "fixture controller must offer another SOCD policy");
    await socdSelect.selectOption(nextSocd);
    await socd.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => {
        const form = document.querySelector('[data-rd-form="apply"]');
        const button = form?.querySelector("button");
        return form && !form.classList.contains("none") && button && !button.disabled;
      },
      null,
      { timeout: 20_000 },
    );
    const dirtyBeforeApply = (await page.locator(".rd-draft-label").textContent())?.trim();
    assert.match(dirtyBeforeApply ?? "", /edited|Unsaved/i);
    await clickAction(page, "apply");
    await page.waitForFunction(
      () => document.querySelector('[data-rd-form="apply"]')?.classList.contains("none"),
      null,
      { timeout: 20_000 },
    );
    assert.match(await page.locator(".rd-flash").textContent(), /applied/i);
    assert.equal(
      (await page.locator(".rd-draft-label").textContent())?.trim(),
      dirtyBeforeApply,
      "Apply must not silently save the draft",
    );

    // Make a structural edit through the product picker. Apply must be
    // offered because the active revision is now older than the draft—not
    // because the draft happens to be unsaved.
    await page.click('[data-nx="rd-ctrls-open"]');
    const add = page.locator('.rd-ctrladd-form[data-usable="true"] button').first();
    await add.click();
    await page.waitForFunction(
      () => {
        const form = document.querySelector('[data-rd-form="apply"]');
        const button = form?.querySelector("button");
        return form && !form.classList.contains("none") && button && !button.disabled;
      },
      null,
      { timeout: 20_000 },
    );
    await page.click('.rd-ctrlmodal-head button[data-nx="rd-ctrls-close"]');

    // Saving settles disk divergence only. It must not make the older running
    // session appear synchronized with this newer structural draft.
    await clickAction(page, "save");
    await page.waitForFunction(
      () => document.querySelector(".rd-flash")?.textContent?.includes("saved for later"),
    );
    assert.match(await page.locator(".rd-flash").textContent(), /saved for later/i);
    assert.equal(await applyButtonIsReady(page), true);

    const savedSocd = await socdSelect.inputValue();
    const changedSocd = await socdSelect.locator("option").evaluateAll(
      (options, current) => options.find((option) => option.value !== current)?.value ?? "",
      savedSocd,
    );
    await socdSelect.selectOption(changedSocd);
    await socd.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => /edited|Unsaved/i.test(document.querySelector(".rd-draft-label")?.textContent ?? ""),
    );
    const dirtyBeforeReplace = (await page.locator(".rd-draft-label").textContent())?.trim();

    const applyButton = page.locator('[data-rd-form="apply"] button');

    // Freeze Apply's post-refusal refresh, advance the draft from a second
    // tab, then let the first tab continue. The old refusal must never become
    // permission to replace the newer draft/session authority.
    let armApplyRefresh = false;
    let releaseApplyRefresh;
    let reportApplyRefresh;
    const applyRefreshBlocked = new Promise((resolve) => {
      reportApplyRefresh = resolve;
    });
    const applyRefreshGate = new Promise((resolve) => {
      releaseApplyRefresh = resolve;
    });
    await page.route("**/api/redesign*", async (route) => {
      if (!armApplyRefresh) {
        await route.continue();
        return;
      }
      armApplyRefresh = false;
      reportApplyRefresh();
      await applyRefreshGate;
      await route.continue();
    });
    armApplyRefresh = true;
    await applyButton.click();
    await applyRefreshBlocked;
    const authorityPeer = await openBench();
    await openControllerInspector(authorityPeer);
    const peerSocd = authorityPeer.locator('[data-rd-form="controller-socd"]');
    const peerSelect = peerSocd.locator('select[name="socd"]');
    const peerCurrent = await peerSelect.inputValue();
    const peerNext = await peerSelect.locator("option").evaluateAll(
      (options, current) => options.find((option) => option.value !== current)?.value ?? "",
      peerCurrent,
    );
    await peerSelect.selectOption(peerNext);
    await peerSocd.locator('button[type="submit"]').click();
    await authorityPeer.waitForFunction(
      () => document.querySelector(".rd-flash")?.textContent?.includes("Draft updated"),
    );
    releaseApplyRefresh();
    await page.waitForFunction(
      () => document.querySelector(".rd-flash")?.textContent?.includes("changed while Apply was checked"),
    );
    assert.equal(await page.locator("[data-rd-apply-dialog]").isHidden(), true);
    await page.unroute("**/api/redesign*");

    // A refused Apply is not permission on its own. If the mandatory
    // authority refresh cannot complete, keep the precise reload recovery;
    // do not misreport a peer edit or open the replacement decision.
    await page.route("**/api/redesign*", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "not a readable redesign payload",
    }));
    await applyButton.click();
    await page.waitForFunction(
      () => document.querySelector(".rd-flash")?.textContent?.includes("could not refresh"),
    );
    assert.match(await page.locator(".rd-flash").textContent(), /reload to confirm/i);
    assert.doesNotMatch(await page.locator(".rd-flash").textContent(), /changed while Apply was checked/i);
    assert.equal(await page.locator("[data-rd-apply-dialog]").isHidden(), true);
    await page.unroute("**/api/redesign*");

    await applyButton.click();
    const restart = page.locator("[data-rd-apply-dialog]");
    await restart.waitFor({ state: "visible" });
    assert.match(
      await page.locator("[data-rd-apply-message]").textContent(),
      /controller P3|running session/i,
    );
    assert.equal(
      await page.evaluate(() => Boolean(document.activeElement?.closest("[data-rd-apply-dialog]"))),
      true,
      "restart decision must receive focus",
    );
    await page.keyboard.press("Control+k");
    assert.equal(await restart.isVisible(), true, "the command palette cannot displace a modal decision");
    assert.equal(await page.locator(".rd-palette").isHidden(), true);

    // Both Tab directions wrap, proving the dialog is contained rather than
    // merely focused once.
    await page.locator('button[data-rd-apply-cancel]').focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.locator('[data-rd-form="play-replace"] button').evaluate(
        (button) => document.activeElement === button,
      ),
      true,
    );
    await page.locator('[data-rd-form="play-replace"] button').focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.hasAttribute("data-rd-apply-cancel")),
      true,
    );
    await page.keyboard.press("Escape");
    await restart.waitFor({ state: "hidden" });
    assert.equal(await applyButton.evaluate((button) => document.activeElement === button), true);

    // Reopen and explicitly replace. It is Play—not Apply and never Save—so
    // the draft stays dirty while the active revision catches up.
    await applyButton.click();
    await restart.waitFor({ state: "visible" });
    await clickAction(page, "play-replace");
    await restart.waitFor({ state: "hidden" });
    assert.match(await page.locator(".rd-flash").textContent(), /Play started/);
    await page.waitForFunction(
      () => document.querySelector('[data-rd-form="apply"]')?.classList.contains("none"),
      null,
      { timeout: 20_000 },
    );
    assert.equal(
      (await page.locator(".rd-draft-label").textContent())?.trim(),
      dirtyBeforeReplace,
      "Replace session must not silently save the draft",
    );

    await clickAction(page, "stop");
    // Move the draft once more so Start over exercises the dirty-draft
    // confirmation even though the prior three-controller draft was saved.
    await page.click('[data-nx="rd-ctrls-open"]');
    await page.locator('.rd-ctrladd-form[data-usable="true"] button').first().click();
    await page.click('.rd-ctrlmodal-head button[data-nx="rd-ctrls-close"]');
    await openSetup(page);
    const startOver = page.locator(".rd-start-over");
    await startOver.locator("summary").click();
    const confirmation = startOver.locator('input[name="confirm_discard"]');
    assert.equal(await confirmation.isVisible(), true);
    await confirmation.check();
    await startOver.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => document.querySelector(".rd-draft-label")?.textContent?.includes("New draft"),
    );
    assert.match(await page.locator(".rd-flash").textContent(), /Draft discarded/);

    const adopt = page.locator('[data-rd-form="adopt"] button');
    assert.equal(await adopt.isEnabled(), true);
    await adopt.click();
    await page.waitForFunction(
      () => !document.querySelector(".rd-draft-label")?.textContent?.includes("New draft"),
    );
    assert.match(await page.locator(".rd-flash").textContent(), /loaded into this draft/i);

    // Recovery remains reachable independently of the draft. Releasing the
    // exact held device returns it to ordinary typing and re-arms preparation.
    await openSetup(page);
    const release = page.locator('[data-rd-form="capture-release"]').first();
    await release.locator('input[name="confirm_release"]').check();
    await release.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-rd-form="capture-prepare"]')?.classList.contains("none"),
      null,
      { timeout: 20_000 },
    );
    assert.match(await page.locator(".rd-flash").textContent(), /released|ordinary typing/i);

    // Polling can advance hidden form identities. Checked destructive/device
    // consent must be revoked before the newly served authority can be used.
    await openSetup(page);
    await startOver.locator("summary").click();
    await confirmation.check();
    const peerSocdAgain = authorityPeer.locator('[data-rd-form="controller-socd"]');
    const peerSelectAgain = peerSocdAgain.locator('select[name="socd"]');
    const peerCurrentAgain = await peerSelectAgain.inputValue();
    const peerNextAgain = await peerSelectAgain.locator("option").evaluateAll(
      (options, current) => options.find((option) => option.value !== current)?.value ?? "",
      peerCurrentAgain,
    );
    await peerSelectAgain.selectOption(peerNextAgain);
    await peerSocdAgain.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => {
        const discard = document.querySelector('input[name="confirm_discard"]');
        return discard && !discard.checked && !document.querySelector(".rd-start-over")?.hasAttribute("open");
      },
      null,
      { timeout: 10_000 },
    );

    await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    await authorityPeer.click('[data-nx="rd-devs-open"]');
    await authorityPeer.getByRole("button", { name: /Logitech G915 TKL/ }).click();
    await authorityPeer.click('.rd-devmodal-head button[data-nx="rd-devs-close"]');
    const logitechCard = authorityPeer.locator('.rd-devcard', { hasText: "Logitech G915 TKL" });
    await logitechCard.locator('[data-rd-form="device"] button').click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(
        'input[name="confirm_spare_keyboard"], input[name="confirm_rebind"], ' +
          'input[name="confirm_machine_certificate"]',
      )).every((input) => !input.checked),
      null,
      { timeout: 10_000 },
    );

    assert.deepEqual(page.ksxNoise, []);
    assert.deepEqual(authorityPeer.ksxNoise, []);
    await authorityPeer.close();
    await page.close();
  });
});
