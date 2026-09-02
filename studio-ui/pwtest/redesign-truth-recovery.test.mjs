// Focused browser contract for the redesign's truthful setup/recovery UX.
// It drives the real Forma island and Rust macro fixture: no mocked page DOM.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_TRUTH_RECOVERY_PORT ?? 4562);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

const IPAC = "usb:d209:0430:00";
const G915 = "usb:046d:c545:00";

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
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the redesign truth/recovery fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT), "--generation=truth-recovery"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "redesign truth/recovery fixture");
  }
});

async function openBench(viewport = { width: 1600, height: 1000 }) {
  const page = await browser.newPage({ viewport });
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

async function ensureIpacStagedAndMounted(page) {
  const board = page.locator(`.rd-dev-node[data-selector="${IPAC}"]`);
  await page.locator('[data-nx="rd-devs-open"]').click();
  const row = page.locator(`.rd-devmodal button[data-selector="${IPAC}"]`);
  await row.waitFor({ state: "visible" });
  const isStaged = (await row.getAttribute("aria-current")) === "true";
  const isMounted = (await row.getAttribute("aria-pressed")) === "true";
  if (!isMounted) {
    await row.click();
    await page.waitForFunction(
      (selector) => document.querySelector(
        `.rd-devmodal button[data-selector="${selector}"]`,
      )?.getAttribute("aria-pressed") === "true",
      IPAC,
    );
  }
  await page.locator('.rd-devmodal-head [data-nx="rd-devs-close"]').click();
  await board.waitFor({ state: "visible" });

  // Browser-owned canvas membership can intentionally outlive Start over.
  // In that case the board is already present but its exact source must be
  // explicitly added back to the new draft.
  if (!isStaged && isMounted) {
    const add = board.locator(".rd-stagebtn");
    await add.waitFor({ state: "visible" });
    await add.click();
  }
  await page.waitForFunction(
    (selector) => document.querySelector(
      `.rd-devmodal button[data-selector="${selector}"]`,
    )?.getAttribute("aria-current") === "true",
    IPAC,
  );
  return board;
}

async function ensureIpacPrepared(page) {
  const board = await ensureIpacStagedAndMounted(page);
  const details = board.locator("[data-rd-device-capture]");
  await details.waitFor({ state: "attached" });
  if (await details.locator('[data-rd-form="capture-release"]').count()) return board;

  const deviceLabel = await board.getAttribute("aria-label");
  assert.ok(deviceLabel, "the exact encoder board exposes its device label");
  assert.ok(
    ((await details.locator(":scope > summary").getAttribute("aria-label")) ?? "")
      .includes(deviceLabel),
    "the Windows input summary names the exact encoder",
  );

  if (!(await details.evaluate((element) => element.open))) {
    await details.locator(":scope > summary").click();
  }
  const prepare = details.locator('[data-rd-form="capture-prepare"]');
  await prepare.waitFor({ state: "visible" });
  assert.ok(
    ((await prepare.locator('button[type="submit"]').getAttribute("aria-label")) ?? "")
      .includes(deviceLabel),
    "the Prepare action names the exact encoder",
  );
  await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
    checks.forEach((check) => check.click());
  });
  await page.waitForFunction(() => {
    const target = document.querySelector(
      '.rd-dev-node[data-selector="usb:d209:0430:00"] ' +
        '[data-rd-form="capture-prepare"] button[type="submit"]',
    )?.getBoundingClientRect();
    const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
    return Boolean(target && viewport && !document.querySelector(".is-camera-animating") &&
      target.top >= viewport.top && target.left >= viewport.left &&
      target.bottom <= viewport.bottom && target.right <= viewport.right);
  }, null, { timeout: 5_000 });
  const prepareGeometry = await prepare.locator('button[type="submit"]').evaluate((button) => {
    const target = button.getBoundingClientRect();
    const viewport = document.querySelector(".forma-canvas-viewport")?.getBoundingClientRect();
    const board = button.closest(".rd-dev-node")?.getBoundingClientRect();
    const shell = button.closest(".rd-encoder-device-shell");
    return viewport && board
      ? {
          target: { top: target.top, right: target.right, bottom: target.bottom, left: target.left },
          viewport: {
            top: viewport.top,
            right: viewport.right,
            bottom: viewport.bottom,
            left: viewport.left,
          },
          board: { top: board.top, right: board.right, bottom: board.bottom, left: board.left },
          shell: shell
            ? {
                clientHeight: shell.clientHeight,
                scrollHeight: shell.scrollHeight,
                scrollTop: shell.scrollTop,
                overflowY: getComputedStyle(shell).overflowY,
              }
            : null,
        }
      : null;
  });
  assert.ok(
    prepareGeometry &&
      prepareGeometry.target.top >= prepareGeometry.viewport.top &&
      prepareGeometry.target.left >= prepareGeometry.viewport.left &&
      prepareGeometry.target.bottom <= prepareGeometry.viewport.bottom &&
      prepareGeometry.target.right <= prepareGeometry.viewport.right,
    `expanded exact-device action remains inside the canvas: ${JSON.stringify(prepareGeometry)}`,
  );
  await prepare.locator('button[type="submit"]').click();
  await page.waitForFunction(
    (selector) => Boolean(document.querySelector(
      `.rd-dev-node[data-selector="${selector}"] [data-rd-form="capture-release"]`,
    )),
    IPAC,
    { timeout: 20_000 },
  );
  return board;
}

async function makeIpacRecoveryOrphan(page) {
  await ensureIpacPrepared(page);
  const profile = page.locator(".rd-profiled");
  if (!(await profile.evaluate((element) => element.open))) {
    await page.locator(".rd-profile-sum").click();
  }
  const startOver = profile.locator(".rd-start-over");
  if (!(await startOver.evaluate((element) => element.open))) {
    await startOver.locator(":scope > summary").click();
  }
  const confirmation = startOver.locator('input[name="confirm_discard"]');
  if (await confirmation.isVisible()) await confirmation.check();
  await startOver.locator('button[type="submit"]').click();
  await page.waitForFunction(
    () => document.querySelector(".rd-profile-state")?.textContent?.includes("New draft") &&
      document.querySelector("[data-forma-island]")?.dataset.rdMutationPending !== "true",
    null,
    { timeout: 20_000 },
  );

  const attention = page.locator('[data-rd-attention]:visible');
  await attention.waitFor({ state: "visible" });
  const review = attention.locator('[data-nx="rd-review-recovery"]');
  const hitTruth = await review.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const header = document.querySelector(".rd-top")?.getBoundingClientRect();
    return {
      box: { top: box.top, right: box.right, bottom: box.bottom, left: box.left },
      header: header
        ? { top: header.top, right: header.right, bottom: header.bottom, left: header.left }
        : null,
      hit: hit?.getAttribute("class") ?? hit?.tagName ?? "",
      rootClass: document.querySelector(".rd")?.getAttribute("class") ?? "",
    };
  });
  assert.equal(
    await review.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === button || Boolean(hit && button.contains(hit));
    }),
    true,
    `exact recovery door remains the pointer hit target: ${JSON.stringify(hitTruth)}`,
  );
  await review.click();
  const sheet = page.locator('[data-rd-recovery-sheet]:visible');
  await sheet.waitFor({ state: "visible" });
  const row = sheet.locator(`.rd-held-row[data-held-selector="${IPAC}"]`);
  await row.waitFor({ state: "visible" });
  await page.waitForFunction(
    (selector) => document.activeElement?.matches(
      `.rd-held-row[data-held-selector="${selector}"]`,
    ),
    IPAC,
  );
  return { sheet, row };
}

async function makeDraftDirty(page) {
  const card = page.locator('.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]');
  await card.waitFor({ state: "visible" });
  await page.locator('.navigator-item[data-instance-id="ctrl-slot-1"]')
    .evaluate((button) => button.click());
  const form = page.locator('[data-rd-form="controller-socd"]');
  await form.waitFor({ state: "visible" });
  const beforeRevision = await page.locator(
    '[data-rd-form="save"] input[name="expected_revision"]',
  ).inputValue();
  const select = form.locator('select[name="socd"]');
  const current = await select.inputValue();
  const next = await select.locator("option").evaluateAll(
    (options, value) => options.find((option) => option.value !== value)?.value ?? "",
    current,
  );
  assert.notEqual(next, "", "the fixture must offer another SOCD policy");
  await select.selectOption(next);
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction((before) => {
    const root = document.querySelector("[data-forma-island]");
    const revision = document.querySelector(
      '[data-rd-form="save"] input[name="expected_revision"]',
    )?.value ?? "";
    return root?.dataset.rdMutationPending !== "true" && revision !== before;
  }, beforeRevision);
  const close = page.locator('.rd-inspector:not([hidden]) [data-nx="rd-insp-close"]');
  if (await close.count()) await close.click();
}

async function assertGlobalMutationLock(page) {
  const lock = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll(
      'form[data-rd-form] button[type="submit"], ' +
        'form[data-rd-form] input[type="submit"], select.rd-ctrlplayer, ' +
        '[data-nx="rd-dev-toggle"], [data-nx="rd-offline-remove"], ' +
        '[data-nx="rd-rescan"], ' +
        '[data-nx="rd-refresh-retry"], [data-rd-live-retry]',
    ));
    return {
      count: controls.length,
      enabled: controls.filter((control) => !("disabled" in control) || !control.disabled)
        .map((control) => control.outerHTML.slice(0, 160)),
    };
  });
  assert.ok(lock.count >= 8, "the fixture must expose a meaningful island-wide mutation surface");
  assert.deepEqual(lock.enabled, [], "every mutation control is locked during one transaction");
}

async function delayedLifecycle(page, {
  path: requestPath,
  formKind,
  pendingText,
  settledFlash,
  settledFormKind = formKind,
}) {
  const url = `${BASE}${requestPath}`;
  let releaseRoute;
  const gate = new Promise((resolve) => {
    releaseRoute = resolve;
  });
  let markSeen;
  const seen = new Promise((resolve) => {
    markSeen = resolve;
  });
  let requestCount = 0;
  const handler = async (route) => {
    requestCount += 1;
    markSeen();
    await gate;
    await route.continue();
  };
  await page.route(url, handler);

  const button = page.locator(
    `[data-rd-form="${formKind}"] button[type="submit"]:visible`,
  ).first();
  const settledAriaLabel = await button.getAttribute("aria-label");
  try {
    await button.click();
    await seen;
    await page.waitForFunction(
      () => document.querySelector("[data-forma-island]")?.getAttribute("aria-busy") === "true",
    );
    assert.equal(await button.getAttribute("aria-busy"), "true");
    assert.equal(
      await button.locator(".rd-action-pending").isVisible(),
      true,
      "the named pending label is painted, not merely present in the DOM",
    );
    assert.equal(
      (await button.locator(".rd-action-pending:not([hidden])").textContent())?.trim(),
      pendingText,
      "the initiating action names the work that is pending",
    );
    assert.equal(
      await page.getByRole("button", { name: pendingText, exact: true }).count(),
      1,
      "the visible pending copy is also the action's accessible name",
    );
    assert.equal(
      await button.getAttribute("aria-label"),
      pendingText,
      "the pending accessible name is explicit even when the settled button had richer copy",
    );
    assert.equal(await button.locator(".rd-action-label:not([hidden])").count(), 0);
    await assertGlobalMutationLock(page);
    assert.equal(requestCount, 1, "one click issues exactly one lifecycle request");
  } finally {
    releaseRoute();
  }
  await page.waitForFunction(
    () => !document.querySelector("[data-forma-island]")?.hasAttribute("aria-busy") &&
      document.querySelector("[data-forma-island]")?.dataset.rdMutationPending !== "true",
    null,
    { timeout: 20_000 },
  );
  await page.unroute(url, handler);
  await page.waitForFunction(
    (expected) => document.querySelector(".rd-flash")?.textContent?.includes(expected),
    settledFlash,
    { timeout: 20_000 },
  );
  assert.equal(requestCount, 1, "settling the transaction does not replay its POST");
  assert.equal(await page.locator("button[data-rd-pending], button[aria-busy='true']").count(), 0);
  assert.equal(
    await page.locator('.rd-action-pending:visible').count(),
    0,
    "no stale pending label survives the authoritative repaint",
  );
  const settledButton = page.locator(
    `[data-rd-form="${settledFormKind}"] button[type="submit"]:visible`,
  ).first();
  assert.equal(await settledButton.count(), 1, "the authoritative settled action is present");
  assert.equal(await settledButton.getAttribute("data-rd-pending"), null);
  assert.equal(await settledButton.getAttribute("aria-busy"), null);
  assert.equal(await settledButton.locator(".rd-action-label").isVisible(), true);
  assert.equal(await settledButton.locator(".rd-action-pending").isVisible(), false);
  if (settledFormKind === formKind) {
    assert.equal(
      await settledButton.getAttribute("aria-label"),
      settledAriaLabel,
      "settling restores the exact aria-label contract, including an absent attribute",
    );
  }
}

describe("redesign truth, recovery and pending feedback", { concurrency: false }, () => {
  test("a refused exact-device lifecycle action restores its rich accessible name", async () => {
    const page = await openBench();
    const board = await ensureIpacStagedAndMounted(page);
    const disclosure = board.locator("[data-rd-device-capture]");
    await disclosure.waitFor({ state: "attached" });
    if (!(await disclosure.evaluate((details) => details.open))) {
      await disclosure.locator(":scope > summary").click();
    }
    const form = disclosure.locator('form[data-rd-form^="capture-"]:visible').first();
    await form.waitFor({ state: "visible" });
    await form.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    const button = form.locator('button[type="submit"]');
    const settledName = await button.getAttribute("aria-label");
    assert.ok(
      settledName?.includes((await board.getAttribute("aria-label")) ?? "missing-device"),
      "the settled action starts with its exact-device accessible name",
    );
    const pendingText = (await button.locator(".rd-action-pending").textContent())?.trim() ?? "";
    const actionPath = new URL(await form.getAttribute("action"), BASE).pathname;
    let releaseRequest;
    const requestGate = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    let markRequest;
    const requestSeen = new Promise((resolve) => {
      markRequest = resolve;
    });
    const handler = async (route) => {
      markRequest();
      await requestGate;
      await route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" });
    };
    await page.route(`${BASE}${actionPath}`, handler);
    try {
      await button.click();
      await requestSeen;
      assert.equal(await button.getAttribute("aria-label"), pendingText);
      assert.equal(
        await page.getByRole("button", { name: pendingText, exact: true }).count(),
        1,
        "the visible exact-device pending state is the accessible name",
      );
    } finally {
      releaseRequest();
    }
    await page.waitForFunction(
      () => !document.querySelector("[data-rd-mutation-pending]"),
      null,
      { timeout: 20_000 },
    );
    await page.unroute(`${BASE}${actionPath}`, handler);
    assert.equal(await button.getAttribute("aria-label"), settledName);
    assert.equal(await button.getAttribute("aria-busy"), null);
    assert.equal(await button.locator(".rd-action-label").isVisible(), true);
    assert.equal(await button.locator(".rd-action-pending").isVisible(), false);
    assert.deepEqual(
      page.ksxNoise.filter((line) => !line.includes("status of 503 (Service Unavailable)")),
      [],
      "the deliberately refused request is the only browser diagnostic",
    );
    await page.close();
  });

  test("an open shared policy keeps reconciling external lifecycle truth", async () => {
    const page = await openBench();
    const board = await ensureIpacStagedAndMounted(page);
    const opener = board.locator('[data-nx="rd-shared-policy"]');
    await opener.click();
    const editor = page.locator('#rd-shared-policy-editor[open]');
    await editor.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.activeElement?.matches(
        '#rd-shared-policy-editor button[role="radio"]',
      ),
    );
    const focusedPolicyName = await page.evaluate(() =>
      document.activeElement?.closest("form")
        ?.querySelector('input[name="blocking"]')?.value ?? ""
    );
    const policyNames = await editor.locator('input[name="blocking"]')
      .evaluateAll((inputs) => inputs.map((input) => input.value));
    const externalPolicyName = policyNames.find((name) => name !== focusedPolicyName) ?? "";
    assert.ok(focusedPolicyName, "the open editor focuses a named policy");
    assert.ok(externalPolicyName, "the fixture exposes another policy for an external flip");
    let serveExternalSession = false;
    let externalReads = 0;
    await page.route("**/api/redesign*", async (route) => {
      if (!serveExternalSession) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const payload = await response.json();
      externalReads += 1;
      const stageRevision = "external-stage-while-policy-open";
      payload.operations.active_stage_revision = stageRevision;
      payload.operations.session = {
        ...payload.operations.session,
        reachable: true,
        running: true,
        origin: "staged",
        line: "Play was started from another client.",
        active: {
          ...(payload.operations.session.active ?? {}),
          elapsed: "00:01",
          input: "External input",
          outputs: "1 virtual controller",
          escape_hatch: "Stop returns input to Windows.",
          stage_revision: stageRevision,
        },
      };
      payload.operations.play = {
        ...payload.operations.play,
        allowed: false,
        visible: false,
        reason: "Play is already running.",
      };
      payload.operations.stop = {
        ...payload.operations.stop,
        label: "Stop external Play",
        allowed: true,
        visible: true,
        reason: "Stop the running session.",
      };
      payload.capture_rows = payload.capture_rows.map((row) => ({
        ...row,
        chosen: row.name === externalPolicyName,
        cls: row.name === externalPolicyName ? "n-radio on" : "n-radio",
      }));
      await route.fulfill({ response, json: payload });
    });
    try {
      serveExternalSession = true;
      await page.waitForFunction(
        () => document.querySelector(".rd-profile-session")?.textContent?.includes("Playing") &&
          document.querySelector('[data-rd-form="stop"] button:not([disabled])')
            ?.textContent?.includes("Stop external Play"),
        null,
        { timeout: 7_000 },
      );
      assert.ok(externalReads > 0, "the open disclosure did not suppress background authority reads");
      assert.equal(await editor.evaluate((details) => details.open), true);
      assert.equal(
        await editor.locator(`input[name="blocking"][value="${externalPolicyName}"]`)
          .locator("xpath=parent::form/button[@role='radio']")
          .getAttribute("aria-checked"),
        "true",
        "the external policy fact repaints while the editor remains open",
      );
      assert.equal(
        await editor.evaluate((details) => details.contains(document.activeElement)),
        true,
        "a policy/lifecycle repaint preserves the open editor and its keyboard context",
      );
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.closest("form")
            ?.querySelector('input[name="blocking"]')?.value ?? ""
        ),
        focusedPolicyName,
        "a chosen-state flip restores the same policy by its stable wire name",
      );
      assert.equal(
        await editor.locator('[role="radio"][tabindex="0"]').count(),
        1,
        "the external repaint keeps one hydrated policy tab stop",
      );
      const stage = page.locator(".forma-canvas-stage");
      const cameraBeforeShortcuts = await stage.evaluate((node) => node.style.transform);
      await page.keyboard.press("-");
      assert.equal(
        await stage.evaluate((node) => node.style.transform),
        cameraBeforeShortcuts,
        "the canvas shortcut remains guarded after focus restoration",
      );
      await page.keyboard.press("Control+k");
      assert.equal(
        await page.locator(".rd-palette").getAttribute("hidden"),
        "",
        "the global palette shortcut remains guarded after focus restoration",
      );
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.closest("form")
            ?.querySelector('input[name="blocking"]')?.value ?? ""
        ),
        focusedPolicyName,
        "guarded global shortcuts do not steal the restored policy focus",
      );
      await editor.locator('[data-nx="rd-shared-policy-close"]').click();
      assert.equal(
        await page.locator('[data-rd-form="stop"] button:visible').isEnabled(),
        true,
        "closing the policy does not reveal stale lifecycle controls",
      );
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("Rescan distinguishes partial and failed 200 responses from authority", async () => {
    const page = await openBench();
    let scanMode = "partial";
    await page.route("**/api/redesign*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("fresh") !== "1") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const payload = await response.json();
      payload.devices.scan_authoritative = false;
      payload.devices.usb_scan_authoritative = scanMode === "partial";
      payload.devices.bluetooth_scan_authoritative = false;
      payload.devices.scan_line = scanMode === "partial"
        ? "Bluetooth scan unavailable; USB discovery answered."
        : "The device provider did not answer.";
      await route.fulfill({ response, json: payload });
    });
    try {
      await page.locator('[data-nx="rd-devs-open"]').click();
      const rescan = page.locator('[data-nx="rd-rescan"]');
      await rescan.click();
      await page.waitForFunction(
        () => document.querySelector(".n-live-sr:not([data-rd-encoder-status])")?.textContent?.startsWith(
          "Device rescan was partial",
        ),
        null,
        { timeout: 10_000 },
      );
      assert.match(
        (await page.locator(".n-live-sr:not([data-rd-encoder-status])").textContent()) ?? "",
        /Bluetooth did not answer/,
      );
      assert.equal(await rescan.getAttribute("aria-label"), "Rescan connected devices");

      scanMode = "failed";
      await rescan.click();
      await page.waitForFunction(
        () => document.querySelector(".n-live-sr:not([data-rd-encoder-status])")?.textContent?.startsWith(
          "Device rescan could not confirm connected devices",
        ),
        null,
        { timeout: 10_000 },
      );
      assert.doesNotMatch(
        (await page.locator(".n-live-sr:not([data-rd-encoder-status])").textContent()) ?? "",
        /Connected devices refreshed/,
      );
      assert.equal(await rescan.getAttribute("aria-busy"), null);
      assert.equal(await rescan.getAttribute("aria-label"), "Rescan connected devices");
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("a superseded fresh Rescan cannot inherit cached-refresh success", async () => {
    const page = await openBench();
    await page.locator('.navigator-item[data-instance-id="ctrl-slot-1"]')
      .evaluate((button) => button.click());
    const filter = page.locator(".rd-binding-filter");
    await filter.waitFor({ state: "visible" });
    await page.locator('[data-nx="rd-devs-open"]').click();

    let releaseFresh;
    const freshGate = new Promise((resolve) => {
      releaseFresh = resolve;
    });
    let markFresh;
    const freshSeen = new Promise((resolve) => {
      markFresh = resolve;
    });
    let markCached;
    const cachedSeen = new Promise((resolve) => {
      markCached = resolve;
    });
    let freshRequests = 0;
    let cachedRequests = 0;
    await page.route("**/api/redesign*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("fresh") === "1") {
        freshRequests += 1;
        markFresh();
        await freshGate;
        try {
          await route.continue();
        } catch {
          // The cached request intentionally aborts this fresh generation.
        }
        return;
      }
      cachedRequests += 1;
      const response = await route.fetch();
      const payload = await response.json();
      payload.devices.scan_authoritative = true;
      payload.devices.usb_scan_authoritative = true;
      payload.devices.bluetooth_scan_authoritative = true;
      await route.fulfill({ response, json: payload });
      markCached();
    });

    try {
      const rescan = page.locator('[data-nx="rd-rescan"]');
      await rescan.click();
      await freshSeen;
      await filter.evaluate((form) => {
        const input = form.querySelector('input[type="search"]');
        input.value = "supersede fresh rescan";
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      });
      await cachedSeen;
      releaseFresh();
      await page.waitForFunction(
        () => document.querySelector(".n-live-sr:not([data-rd-encoder-status])")?.textContent ===
          "Device rescan could not finish. The last known list is still shown.",
        null,
        { timeout: 10_000 },
      );
      assert.equal(freshRequests, 1);
      assert.equal(cachedRequests, 1);
      assert.doesNotMatch(
        (await page.locator(".n-live-sr:not([data-rd-encoder-status])").textContent()) ?? "",
        /Connected devices refreshed/,
      );
      assert.equal(await rescan.getAttribute("aria-busy"), null);
      assert.equal(await rescan.getAttribute("aria-label"), "Rescan connected devices");
    } finally {
      releaseFresh();
      await page.unrouteAll({ behavior: "wait" });
    }
    assert.deepEqual(page.ksxNoise, []);
    await page.close();
  });

  test("the board-attached Play policy flips and clamps inside desktop and compact canvases", async () => {
    for (const viewportSize of [
      { width: 1600, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const page = await openBench(viewportSize);
      try {
        const attention = page.locator('[data-rd-attention]:visible');
        await attention.waitFor({ state: "visible" });
        await attention.getByRole("button", { name: "Review preparation" }).click();
        const board = page.locator(`.rd-dev-node[data-selector="${IPAC}"]`);
        await board.waitFor({ state: "visible" });
        const inspectorClose = page.locator('[data-nx="rd-insp-close"]:visible');
        if (await inspectorClose.count()) await inspectorClose.click();
        await page.waitForFunction(
          () => !document.querySelector(".forma-canvas-viewport.is-camera-animating"),
        );
        // Proximity chips paint on a 150ms settle debounce. Wait for that
        // real delayed layer so compact rescue chrome cannot pass merely
        // because an intercepting chip has not arrived yet.
        await page.locator(".rd-chip").first().waitFor({ state: "visible" });

        // Exercise the real canvas drag path and leave only a narrow shelf
        // below the board controls. The editor must flip above that shelf and
        // remain fully reachable even in the 390px canvas viewport.
        const handle = board.locator(".widget-drag-handle");
        const handleBox = await handle.boundingBox();
        const beforeDrag = await page.evaluate((selector) => {
          const board = document.querySelector(`.rd-dev-node[data-selector="${selector}"]`);
          const handle = board?.querySelector(".widget-drag-handle");
          const rect = handle?.getBoundingClientRect();
          const hit = rect
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
          const boardRect = board?.getBoundingClientRect();
          const hitRect = hit?.getBoundingClientRect();
          const overlappingChips = rect
            ? Array.from(document.querySelectorAll(".rd-chip")).filter((chip) => {
              const chipRect = chip.getBoundingClientRect();
              return chipRect.left < rect.right + 8 && chipRect.right > rect.left - 8 &&
                chipRect.top < rect.bottom + 8 && chipRect.bottom > rect.top - 8;
            }).length
            : 0;
          return {
            boardTop: boardRect?.top,
            boardBottom: boardRect?.bottom,
            boardLeft: boardRect?.left,
            boardRight: boardRect?.right,
            handleRect: rect && {
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            hitRect: hitRect && {
              top: hitRect.top,
              right: hitRect.right,
              bottom: hitRect.bottom,
              left: hitRect.left,
            },
            canvasY: board?.getAttribute("data-canvas-y"),
            edge: board?.getAttribute("data-widget-command-edge"),
            state: board?.getAttribute("data-widget-command-state"),
            anchorX: board?.getAttribute("data-widget-chrome-anchor-x"),
            anchorY: board?.getAttribute("data-widget-chrome-anchor-y"),
            hitClass: hit?.getAttribute("class"),
            overlappingChips,
            handleOwnsHit: hit === handle || Boolean(hit && handle?.contains(hit)),
          };
        }, IPAC);
        const dragDelta = await page.evaluate((selector) => {
          const viewport = document.querySelector(".forma-canvas-viewport")
            ?.getBoundingClientRect();
          const policy = document.querySelector(
            `.rd-dev-node[data-selector="${selector}"] .rd-device-policy`,
          )?.getBoundingClientRect();
          return viewport && policy ? viewport.bottom - policy.bottom - 12 : 0;
        }, IPAC);
        assert.ok(handleBox, "the physical board keeps its canvas move handle");
        assert.equal(
          beforeDrag.overlappingChips,
          0,
          `proximity navigation stays clear of the move handle: ${JSON.stringify(beforeDrag)}`,
        );
        assert.equal(
          beforeDrag.handleOwnsHit,
          true,
          `the visible move handle owns its hit target: ${JSON.stringify(beforeDrag)}`,
        );
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2 + dragDelta,
          { steps: 8 },
        );
        await page.mouse.up();
        await page.waitForFunction((selector) => {
          const board = document.querySelector(`.rd-dev-node[data-selector="${selector}"]`);
          return Boolean(board && !board.classList.contains("is-dragging") &&
            !document.querySelector(".forma-canvas-viewport.is-dragging-widget"));
        }, IPAC);
        if (await inspectorClose.isVisible()) {
          await inspectorClose.click();
          await inspectorClose.waitFor({ state: "hidden" });
        }
        const edgeGeometry = await page.evaluate(({ selector, dragDelta }) => {
          const viewport = document.querySelector(".forma-canvas-viewport")
            ?.getBoundingClientRect();
          const board = document.querySelector(`.rd-dev-node[data-selector="${selector}"]`);
          const boardRect = board?.getBoundingClientRect();
          const policy = document.querySelector(
            `.rd-dev-node[data-selector="${selector}"] .rd-device-policy`,
          )?.getBoundingClientRect();
          return viewport && policy
            ? {
                viewportBottom: viewport.bottom,
                policyTop: policy.top,
                policyBottom: policy.bottom,
                boardTop: boardRect?.top,
                boardBottom: boardRect?.bottom,
                canvasY: board?.getAttribute("data-canvas-y"),
                dragDelta,
              }
            : null;
        }, { selector: IPAC, dragDelta });
        assert.ok(edgeGeometry, "the dragged board policy remains rendered");
        assert.ok(
          edgeGeometry.viewportBottom - edgeGeometry.boardBottom <= 120,
          // The canvas deliberately retains a screen-space rescue shelf for
          // the selected board. A tall board can have content below its policy
          // row, so board geometry—not one internal control—is the stable proof
          // that the real drag reached the bottom clamp.
          `the drag did not reach the bottom-edge rescue shelf: ${JSON.stringify(edgeGeometry)}`,
        );

        const opener = board.locator('[data-nx="rd-shared-policy"]');
        const peer = page.locator(
          '.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]',
        );
        await peer.waitFor({ state: "visible" });
        await peer.dispatchEvent("pointerdown", {
          button: 0,
          isPrimary: true,
          pointerId: 91,
          pointerType: "mouse",
        });
        await page.waitForFunction(
          () => document.querySelector(
            '.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]',
          )?.getAttribute("aria-current") === "true",
        );
        // Keyboard/AT activation has no pointerdown on the owning board. The
        // policy command itself must still select and raise its exact board.
        await opener.evaluate((button) => button.click());

        const editor = page.locator('#rd-shared-policy-editor[open]');
        await editor.waitFor({ state: "visible" });
        const stack = await page.evaluate((selector) => {
          const board = document.querySelector(`.rd-dev-node[data-selector="${selector}"]`);
          const otherZ = Array.from(document.querySelectorAll(
            ".forma-canvas-stage > [data-instance-id]",
          )).filter((item) => item !== board)
            .map((item) => Number(item.getAttribute("data-canvas-z")))
            .filter(Number.isFinite);
          return {
            current: board?.getAttribute("aria-current"),
            boardZ: Number(board?.getAttribute("data-canvas-z")),
            maxOtherZ: Math.max(0, ...otherZ),
          };
        }, IPAC);
        assert.equal(stack.current, "true", "the invoking physical board becomes primary");
        assert.ok(
          stack.boardZ > stack.maxOtherZ,
          `the policy-owning board is above every possible overlap: ${JSON.stringify(stack)}`,
        );
        assert.equal(
          await page.locator(".rd.is-inspector-open").count(),
          0,
          "board policy interaction never lets the responsive Inspector cover its dialog",
        );
        assert.equal(
          await editor.evaluate((element, selector) =>
            element.closest(".rd-dev-node")?.getAttribute("data-selector") === selector
          , IPAC),
          true,
          "the shared editor is attached to the exact board that opened it",
        );
        assert.equal(await opener.getAttribute("aria-expanded"), "true");
        assert.equal(
          await editor.locator("xpath=ancestor::*[@data-rd-policy-editor-host]").getAttribute(
            "data-policy-placement",
          ),
          "above",
          "a bottom-edge board flips its policy popup above the remaining shelf",
        );
        const policyGroup = editor.getByRole("radiogroup", {
          name: "Input behavior while playing",
        });
        const policyOptions = policyGroup.getByRole("radio");
        assert.equal(await policyGroup.count(), 1, "the single-choice policy has a name");
        assert.equal(await policyOptions.count(), 3, "all choices expose radio semantics");
        assert.equal(
          await policyGroup.getByRole("radio", { checked: true }).count(),
          1,
          "exactly one shared policy is checked",
        );
        assert.deepEqual(
          await policyOptions.evaluateAll((options) => options.map((option) => ({
            kind: option.closest("form")?.getAttribute("data-rd-form"),
            method: option.closest("form")?.getAttribute("method"),
          }))),
          [
            { kind: "blocking", method: "post" },
            { kind: "blocking", method: "post" },
            { kind: "blocking", method: "post" },
          ],
          "radio semantics preserve the three guarded POST forms",
        );
        const chosen = policyGroup.getByRole("radio", { checked: true });
        assert.equal(
          await chosen.evaluate((button) => document.activeElement === button),
          true,
          "the current policy receives focus when the editor opens",
        );

        const geometry = await page.evaluate(() => {
          const viewport = document.querySelector(".forma-canvas-viewport")
            ?.getBoundingClientRect();
          const popup = document.querySelector(
            "#rd-shared-policy-editor[open] .rd-boardpick-pop",
          )?.getBoundingClientRect();
          const host = document.querySelector(
            "#rd-shared-policy-editor[open]",
          )?.closest("[data-rd-policy-editor-host]");
          const policy = host?.closest(".rd-device-policy");
          const board = host?.closest(".rd-dev-node");
          const hostStyle = host instanceof HTMLElement ? getComputedStyle(host) : null;
          const policyRect = policy?.getBoundingClientRect();
          const boardRect = board?.getBoundingClientRect();
          const chosenButton = document.querySelector(
            '#rd-shared-policy-editor[open] form button[role="radio"][aria-checked="true"]',
          );
          const chosenRect = chosenButton?.getBoundingClientRect();
          const optionRects = Array.from(document.querySelectorAll(
            "#rd-shared-policy-editor[open] form button",
          )).map((button) => {
            const rect = button.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          });
          const painted = chosenRect
            ? document.elementFromPoint(
              chosenRect.left + chosenRect.width / 2,
              chosenRect.top + chosenRect.height / 2,
            )
            : null;
          return viewport && popup
            ? {
                viewport: {
                  left: viewport.left,
                  top: viewport.top,
                  right: viewport.right,
                  bottom: viewport.bottom,
                },
                popup: {
                  left: popup.left,
                  top: popup.top,
                  right: popup.right,
                  bottom: popup.bottom,
                },
                policy: policyRect && {
                  left: policyRect.left,
                  top: policyRect.top,
                  right: policyRect.right,
                  bottom: policyRect.bottom,
                  offsetWidth: policy instanceof HTMLElement ? policy.offsetWidth : null,
                },
                board: boardRect && {
                  left: boardRect.left,
                  top: boardRect.top,
                  right: boardRect.right,
                  bottom: boardRect.bottom,
                },
                placement: host?.getAttribute("data-policy-placement"),
                shiftX: hostStyle?.getPropertyValue("--rd-policy-shift-x"),
                shiftY: hostStyle?.getPropertyValue("--rd-policy-shift-y"),
                availableWidth: hostStyle?.getPropertyValue("--rd-policy-available-width"),
                stageTransform: document.querySelector(".forma-canvas-stage")?.getAttribute("style"),
                cameraAnimating: Boolean(document.querySelector(".is-camera-animating")),
                chosenIsPainted: Boolean(
                  chosenButton && painted &&
                    (chosenButton === painted || chosenButton.contains(painted)),
                ),
                optionRects,
                horizontalOverflow:
                  document.documentElement.scrollWidth - document.documentElement.clientWidth,
              }
            : null;
        });
        assert.ok(geometry, "the canvas viewport and policy popup are rendered");
        assert.ok(
          geometry.popup.left >= geometry.viewport.left - 1 &&
            geometry.popup.right <= geometry.viewport.right + 1 &&
            geometry.popup.top >= geometry.viewport.top - 1 &&
            geometry.popup.bottom <= geometry.viewport.bottom + 1,
          `the ${viewportSize.width}px policy popup stays within the clipped canvas viewport: ${JSON.stringify(geometry)}`,
        );
        assert.equal(
          geometry.chosenIsPainted,
          true,
          `the focused policy remains pointer reachable: ${JSON.stringify(geometry)}`,
        );
        assert.equal(geometry.optionRects.length, 3, "all three input policies are rendered");
        assert.ok(
          geometry.optionRects.every((rect) =>
            rect.left >= geometry.viewport.left - 1 &&
            rect.right <= geometry.viewport.right + 1 &&
            rect.top >= geometry.viewport.top - 1 &&
            rect.bottom <= geometry.viewport.bottom + 1
          ),
          `every policy option stays inside the ${viewportSize.width}px viewport: ${JSON.stringify(geometry)}`,
        );
        assert.ok(geometry.horizontalOverflow <= 1, "the popup does not widen the document");

        const stage = page.locator(".forma-canvas-stage");
        const cameraBeforeDialogKeys = await stage.evaluate((node) => node.style.transform);
        await page.keyboard.press("-");
        assert.equal(
          await stage.evaluate((node) => node.style.transform),
          cameraBeforeDialogKeys,
          "the canvas zoom shortcut is suspended while the policy dialog owns focus",
        );
        assert.equal(await editor.getAttribute("open"), "");
        assert.equal(
          await chosen.evaluate((button) => document.activeElement === button),
          true,
          "a canvas shortcut does not steal focus from the current policy",
        );
        await page.keyboard.press("?");
        assert.equal(
          await page.locator(".rd-sheet").getAttribute("hidden"),
          "",
          "the shortcut sheet stays closed while the policy dialog owns focus",
        );
        assert.equal(await editor.getAttribute("open"), "");

        const popupBox = await editor.locator(".rd-boardpick-pop").boundingBox();
        assert.ok(popupBox, "the policy popup has a pointer surface");
        await page.mouse.move(
          popupBox.x + popupBox.width / 2,
          popupBox.y + Math.min(popupBox.height / 2, 40),
        );
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, 180);
        await page.keyboard.up("Control");
        assert.equal(
          await stage.evaluate((node) => node.style.transform),
          cameraBeforeDialogKeys,
          "Ctrl-wheel over the policy popup cannot zoom the canvas behind it",
        );
        assert.equal(await editor.getAttribute("open"), "");

        // Escape belongs to the board-local editor before the generic canvas
        // returns focus to the widget proxy. Exercise that exact nested-control
        // path, then reopen so the visible close control keeps its own contract.
        await page.keyboard.press("Escape");
        await editor.waitFor({ state: "hidden" });
        assert.equal(
          await opener.evaluate((button) => document.activeElement === button),
          true,
          "Escape restores focus to the exact board opener",
        );
        assert.equal(await opener.getAttribute("aria-expanded"), "false");
        await opener.click();
        await editor.waitFor({ state: "visible" });
        await opener.click();
        await editor.waitFor({ state: "hidden" });
        assert.equal(
          await opener.evaluate((button) => document.activeElement === button),
          true,
          "clicking the active board opener toggles its editor closed and restores focus",
        );
        await opener.click();
        await editor.waitFor({ state: "visible" });
        const visibleClose = editor.locator('[data-nx="rd-shared-policy-close"]');
        if (viewportSize.width === 390) {
          const closeBox = await visibleClose.boundingBox();
          assert.ok(
            closeBox && closeBox.width >= 43.5 && closeBox.height >= 43.5,
            `the touch close target stays at least 44px: ${JSON.stringify(closeBox)}`,
          );
        }
        await visibleClose.click();
        await editor.waitFor({ state: "hidden" });
        assert.equal(
          await opener.evaluate((button) => document.activeElement === button),
          true,
          "the visible close control restores focus to the exact board opener",
        );

        // Opening the board policy is an overlay within Focus, not an exit
        // from it. Preserve the private camera session while suppressing the
        // competing Inspector that Focus ordinarily paints.
        await page.keyboard.press("f");
        await page.waitForFunction(
          () => document.querySelector(".forma-canvas-viewport")?.getAttribute(
            "data-widget-focus-mode",
          ) === "active",
        );
        await opener.click();
        await editor.waitFor({ state: "visible" });
        assert.equal(
          await page.locator(".forma-canvas-viewport").getAttribute("data-widget-focus-mode"),
          "active",
          "the board policy preserves Focus mode",
        );
        assert.equal(await page.locator(".rd.is-inspector-open").count(), 0);
        await editor.locator('[data-nx="rd-shared-policy-close"]').click();
        await editor.waitFor({ state: "hidden" });
        assert.deepEqual(page.ksxNoise, []);
      } finally {
        if (!page.isClosed()) await page.close();
      }
    }
  });

  test("compact Add and Profile trays stay exclusive without hiding machine recovery", async () => {
    const page = await openBench({ width: 390, height: 844 });
    try {
      const attention = page.locator('[data-rd-attention]:not(.none)');
      await attention.waitFor({ state: "visible" });
      const review = attention.locator('[data-nx="rd-review-recovery"]');
      assert.equal(await review.isVisible(), true, "the only recovery door starts visible");

      await page.locator('[data-nx="rd-devs-open"]').click();
      await page.locator(".rd-devmodal-panel").waitFor({ state: "visible" });
      assert.equal(
        await attention.isVisible(),
        true,
        "the compact Add tray cannot suppress the only exact-device recovery door",
      );
      assert.equal(await review.isVisible(), true);

      await page.locator(".rd-profile-sum").click();
      await page.waitForFunction(
        () => document.querySelector(".rd-profiled")?.hasAttribute("open") === true &&
          document.querySelector(".rd-devmodal")?.hasAttribute("hidden") === true,
      );
      assert.equal(
        await page.locator(".rd-profile-menu button:visible").count() > 0,
        true,
        "opening Profile retires the higher Add tray instead of stacking focus surfaces",
      );

      await page.locator('[data-nx="rd-devs-open"]').click();
      await page.locator(".rd-devmodal-panel").waitFor({ state: "visible" });
      assert.equal(await page.locator(".rd-profiled").evaluate((details) => details.open), false);
      assert.equal(
        await page.locator(".rd-profile-menu button:visible").count(),
        0,
        "Profile actions cannot remain keyboard-visible behind Add",
      );
      assert.equal(await review.isVisible(), true);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      if (!page.isClosed()) await page.close();
    }
  });

  test("the workbench exposes exact recovery, actionable progress and honest device/action states", async () => {
    const page = await openBench();

    // Exact-device recovery is persistent without an operational Setup
    // disclosure. The CTA opens the one source-of-truth board action and puts
    // keyboard focus on its summary.
    assert.equal(await page.locator(".rd-setupd").count(), 0);
    assert.equal(await page.locator(".rd-profiled").evaluate((element) => element.open), false);
    const attention = page.locator("[data-rd-attention]");
    await attention.waitFor({ state: "visible" });
    assert.match(await attention.locator("h2").textContent(), /Ultimarc I-PAC 4 · Preparation required/);
    assert.match(await attention.textContent(), /Prepare this input before Save or Play/i);
    await attention.getByRole("button", { name: "Review preparation" }).click();
    await page.waitForFunction(
      () => document.activeElement?.matches(".rd-device-capture[open] > summary"),
    );

    // The removed journey has no shadow navigation surface. Controllers
    // remains a direct header action and lands focus inside its tray.
    assert.equal(await page.locator("[data-journey-step]").count(), 0);
    await page.locator('[data-nx="rd-ctrls-open"]').click();
    await page.locator(".rd-ctrlmodal-panel").waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest(".rd-ctrlmodal-panel") !== null),
      true,
      "the direct Controllers action lands inside the tray",
    );
    await page.locator('.rd-ctrlmodal-head [data-nx="rd-ctrls-close"]').click();

    // Adding from the picker couples canvas membership to an additive staged
    // source. Keyboard identity lives on its full board; encoder status keeps
    // the richer card vocabulary beside its terminal surface.
    await page.locator('[data-nx="rd-devs-open"]').click();
    const ipacRow = page.locator(`.rd-devmodal button[data-selector="${IPAC}"]`);
    const g915Row = page.locator(`.rd-devmodal button[data-selector="${G915}"]`);
    assert.equal((await ipacRow.locator(".rd-dev-connectedchip").textContent())?.trim(), "Connected");
    assert.equal((await ipacRow.locator(".rd-dev-stagedchip").textContent())?.trim(), "Mapping source");
    assert.equal(
      (await g915Row.locator(".rd-dev-stagedchip").textContent())?.trim(),
      "Mapping controls ready",
    );
    assert.doesNotMatch((await ipacRow.textContent()) ?? "", /staged|mapping input/i);
    for (const [row, selector] of [[ipacRow, IPAC], [g915Row, G915]]) {
      if ((await row.getAttribute("aria-pressed")) !== "true") {
        await row.click();
        await page.waitForFunction(
          (wanted) => document.querySelector(
            `.rd-devmodal button[data-selector="${wanted}"]`,
          )?.getAttribute("aria-pressed") === "true",
          selector,
          { timeout: 10_000 },
        );
      }
    }
    assert.match((await ipacRow.locator(".rd-dev-word").textContent()) ?? "", /On canvas/);
    assert.match((await g915Row.locator(".rd-dev-word").textContent()) ?? "", /On canvas/);
    await page.locator('.rd-devmodal-head [data-nx="rd-devs-close"]').click();

    const inspectorClose = page.locator(
      '.rd-inspector:not([hidden]) [data-nx="rd-insp-close"]',
    );
    if (await inspectorClose.count()) await inspectorClose.click();

    const ipacCard = page.locator(`.rd-dev-node[data-selector="${IPAC}"]`);
    const g915Card = page.locator(`.rd-dev-node[data-selector="${G915}"]`);
    await ipacCard.waitFor({ state: "visible" });
    assert.deepEqual(
      await ipacCard.locator(".rd-device-state").allTextContents(),
      ["Connected", "On canvas", "Independent source", "Preparation required"],
    );
    assert.equal(await g915Card.locator(".rd-device-state").count(), 0);
    assert.equal(await g915Card.getAttribute("data-mapping-available"), "true");
    assert.equal(await g915Card.locator("[data-rd-keyboard-surface]").count(), 1);
    assert.match(
      (await g915Card.locator("[data-rd-keyboard-mapping-status]").textContent()) ?? "",
      /Independent source/i,
    );
    assert.equal(await g915Card.locator(".rd-stagebtn").count(), 0);
    assert.doesNotMatch((await ipacCard.locator(".rd-devcard").textContent()) ?? "", /staged|mapping input/i);
    assert.equal(await g915Card.locator(".rd-devcard").count(), 0);

    // Prepare is gated on purpose so the browser has time to prove the
    // initiating label, aria-busy state, and whole-island transaction lock.
    await attention.getByRole("button", { name: "Review preparation" }).click();
    const prepare = page.locator(
      '.rd-device-capture[open] [data-rd-form="capture-prepare"]:visible',
    );
    await prepare.locator('input[type="checkbox"]').evaluateAll((checks) => {
      checks.forEach((check) => check.click());
    });
    await delayedLifecycle(page, {
      path: "/redesign/capture/prepare",
      formKind: "capture-prepare",
      pendingText: "Preparing…",
      settledFlash: "Keyboard prepared",
      settledFormKind: "save",
    });
    const preparedFocus = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      className: document.activeElement?.getAttribute("class") ?? "",
      label: document.activeElement?.getAttribute("aria-label") ?? "",
      text: document.activeElement?.textContent?.trim().slice(0, 120) ?? "",
    }));
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches(".rd-device-capture > summary")),
      true,
      `a settled Prepare returns focus to the exact board action: ${JSON.stringify(preparedFocus)}`,
    );
    assert.equal(await page.locator("[data-rd-attention]:visible").count(), 0);

    // The same contract holds for the ordinary lifecycle rail. Save, Play and
    // Stop each name their pending state, issue one POST, restore the product
    // lock, and move focus to the next valid lifecycle action.
    await makeDraftDirty(page);
    await page.locator('[data-rd-form="save"] button:visible').waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-rd-form="save"] button:visible').isDisabled(), false);
    await delayedLifecycle(page, {
      path: "/redesign/save",
      formKind: "save",
      pendingText: "Saving…",
      settledFlash: "Setup saved",
    });
    assert.match(await page.locator(".rd-flash").textContent(), /Play was not started or changed/i);
    assert.equal(
      await page.evaluate(() => document.activeElement?.classList.contains("rd-profile-sum")),
      true,
    );

    await delayedLifecycle(page, {
      path: "/redesign/play",
      formKind: "play",
      pendingText: "Starting…",
      settledFlash: "Play is running",
      settledFormKind: "stop",
    });
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('[data-rd-form="stop"]') !== null),
      true,
      "Play completion moves focus to Stop",
    );

    await delayedLifecycle(page, {
      path: "/redesign/stop",
      formKind: "stop",
      pendingText: "Stopping…",
      settledFlash: "Play stopped",
      settledFormKind: "play",
    });
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('[data-rd-form="play"]') !== null),
      true,
      "Stop completion moves focus back to Play",
    );

    assert.deepEqual(page.ksxNoise, [], "the complete truth/recovery loop stays error-free");
    await page.close();
  });

  test("stale workbench recovery stays actionable beside the compact Add tray without stealing focus", async () => {
    const page = await openBench();
    await page.setViewportSize({ width: 420, height: 900 });
    let mode = "fail";
    let releaseRefresh;
    let markRefreshSeen;
    const refreshSeen = new Promise((resolve) => {
      markRefreshSeen = resolve;
    });
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const handler = async (route) => {
      if (mode === "fail") {
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false}' });
        return;
      }
      markRefreshSeen();
      await refreshGate;
      try {
        const response = await route.fetch();
        await route.fulfill({ response });
      } catch {
        await route.abort().catch(() => {});
      }
    };
    // Source authoring focus is URL-backed and may be merged after the first
    // payload (`?slot=1&source=…`). Intercept the endpoint independent of
    // query ordering so every background refresh exercises stale recovery.
    await page.route("**/api/redesign*", handler);
    try {
      const health = page.locator("[data-rd-health-alert]");
      await health.waitFor({ state: "visible", timeout: 8_000 });
      assert.match(await health.textContent(), /Workbench updates are paused/i);
      assert.ok(
        page.ksxNoise.every((message) => /503 \(Service Unavailable\)/.test(message)),
        "only the deliberately injected transport refusal reached the console",
      );
      page.ksxNoise.length = 0;
      const retry = health.locator('[data-nx="rd-refresh-retry"]');
      assert.equal(await health.getByRole("button", { name: "Retry now", exact: true }).count(), 1);
      assert.equal(await retry.isVisible(), true);

      mode = "gate";
      await retry.click();
      await refreshSeen;
      await page.locator('[data-nx="rd-devs-open"]').click();
      await page.locator(".rd-devmodal-panel").waitFor({ state: "visible" });
      assert.equal(await retry.isVisible(), true, "the exact refresh action remains available during Add");
      assert.equal(
        await health.getByRole("button", { name: "Checking…", exact: true }).count(),
        1,
        "the visible compact recovery action names its pending work",
      );
      assert.equal(
        await health.evaluate((element) => getComputedStyle(element).position),
        "fixed",
        "stale transport recovery floats without taking canvas height",
      );
      const geometry = await page.evaluate(() => {
        const alert = document.querySelector("[data-rd-health-alert]")?.getBoundingClientRect();
        const panel = document.querySelector(".rd-devmodal-panel")?.getBoundingClientRect();
        const canvas = document.querySelector(".n-canvas")?.getBoundingClientRect();
        return alert && panel && canvas
          ? { alertBottom: alert.bottom, panelTop: panel.top, canvasHeight: canvas.height }
          : null;
      });
      assert.ok(geometry);
      assert.ok(geometry.alertBottom <= geometry.panelTop, "the refresh toast stays above the tray");
      assert.ok(geometry.canvasHeight >= 260, "the compact canvas reservation remains usable");

      releaseRefresh();
      await page.waitForFunction(
        () => document.querySelector("[data-rd-health-alert]")?.hasAttribute("hidden") &&
          document.querySelector("[data-forma-island]")?.getAttribute("aria-busy") !== "true",
        null,
        { timeout: 20_000 },
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.closest(".rd-devmodal-panel") !== null),
        true,
        "a settled retry leaves focus in the Add tray the user moved to",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseRefresh();
      await page.unroute("**/api/redesign?slot=1", handler);
      if (!page.isClosed()) await page.close();
    }
  });

  test("exact-device recovery converges focus after owned and externally observed release", async () => {
    const page = await openBench();
    try {
      const owned = await makeIpacRecoveryOrphan(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-nx="rd-devs-open"]').click();
      const attentionReview = page.locator(
        '[data-rd-attention]:not(.none) [data-nx="rd-review-recovery"]',
      );
      assert.equal(await attentionReview.isVisible(), true);
      await owned.sheet.locator('[data-nx="rd-recovery-close"]').click();
      await owned.sheet.waitFor({ state: "hidden" });
      assert.equal(
        await attentionReview.evaluate((button) => document.activeElement === button),
        true,
        "closing exact-device recovery returns to its visible compact recovery door",
      );
      const reviewHit = await attentionReview.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        const header = document.querySelector(".rd-top")?.getBoundingClientRect();
        return {
          box: { top: box.top, right: box.right, bottom: box.bottom, left: box.left },
          header: header
            ? { top: header.top, right: header.right, bottom: header.bottom, left: header.left }
            : null,
          hit: hit?.getAttribute("class") ?? hit?.tagName ?? "",
          rootClass: document.querySelector(".rd")?.getAttribute("class") ?? "",
        };
      });
      assert.equal(
        await attentionReview.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return hit === button || Boolean(hit && button.contains(hit));
        }),
        true,
        `compact recovery remains the pointer hit target: ${JSON.stringify(reviewHit)}`,
      );
      await attentionReview.click();
      await owned.sheet.waitFor({ state: "visible" });
      await page.locator('.rd-devmodal-head [data-nx="rd-devs-close"]').click();
      const ownedForm = owned.row.locator('[data-rd-form="capture-release"]');
      await ownedForm.locator('input[name="confirm_release"]').check();
      await ownedForm.locator('button[type="submit"]').click();
      await owned.sheet.waitFor({ state: "hidden", timeout: 20_000 });
      await page.waitForFunction(
        () => document.activeElement?.classList.contains("rd-profile-sum") === true,
        null,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.locator(`.rd-held-row[data-held-selector="${IPAC}"]`).count(),
        0,
        "the successful release removes the exact recovery row",
      );

      const passive = await makeIpacRecoveryOrphan(page);
      const passiveForm = passive.row.locator('[data-rd-form="capture-release"]');
      const passiveConsent = passiveForm.locator('input[name="confirm_release"]');
      await passiveConsent.check();
      await passiveConsent.focus();
      await page.evaluate(() => {
        const live = document.querySelector(".n-live-sr");
        const messages = [];
        const observer = new MutationObserver(() => {
          messages.push(live?.textContent ?? "");
        });
        if (live) observer.observe(live, { childList: true, characterData: true, subtree: true });
        window.__ksxRecoveryAnnouncements = { messages, observer };
      });
      const entries = await passiveForm.evaluate((form) =>
        Array.from(new FormData(form).entries()).map(([name, value]) => [name, String(value)]),
      );
      const response = await fetch(`${BASE}/redesign/capture/release`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(entries),
        redirect: "manual",
      });
      assert.equal(response.status, 303, "the external exact-device release succeeds");

      // No user-owned mutation runs in this page. Its ordinary background
      // refresh must still close stale recovery, revoke consent and put focus
      // on a visible stable destination rather than body or a removed row.
      await passive.sheet.waitFor({ state: "hidden", timeout: 12_000 });
      await page.waitForFunction(
        () => document.activeElement?.classList.contains("rd-profile-sum") === true,
        null,
        { timeout: 10_000 },
      );
      assert.equal(
        await page.locator(`.rd-held-row[data-held-selector="${IPAC}"]`).count(),
        0,
      );
      const recoveryAnnouncements = await page.evaluate(() => {
        const record = window.__ksxRecoveryAnnouncements;
        record?.observer.disconnect();
        delete window.__ksxRecoveryAnnouncements;
        return record?.messages ?? [];
      });
      assert.ok(
        recoveryAnnouncements.some((message) =>
          /recovery closed because no held inputs remain/i.test(message)
        ),
        `passive convergence did not announce recovery closure: ${JSON.stringify(recoveryAnnouncements)}`,
      );
      assert.deepEqual(page.ksxNoise, [], "both recovery convergence paths stay error-free");
    } finally {
      if (!page.isClosed()) await page.close();
    }
  });

  test("capture outage recovery prefers releasable held input and repaints held authority", async () => {
    const page = await openBench();
    let releaseAllowed = true;
    let identityComplete = true;
    let heldNote = "Release this exact prepared input.";
    let released = false;
    const handler = async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      if (payload.capture) {
        payload.capture.mode = "unavailable";
        payload.capture.attention_cls = "rd-attention warn";
        payload.capture.attention_title = "Windows input status unavailable";
        payload.capture.attention_line = "Device inspection did not answer.";
        payload.capture.attention_detail = "Held inputs can still be released safely.";
        payload.capture.attention_review_label = "Review exact inputs";
        payload.capture.attention_retry_cls = "rd-panel-action rd-attention-retry";
        for (const row of payload.capture.held ?? []) {
          row.can_release = releaseAllowed;
          row.note = heldNote;
          if (!identityComplete) {
            row.selector = "";
            row.instance = "";
          }
        }
      }
      await route.fulfill({ response, json: payload });
    };
    const repaint = async (theme) => {
      await page.click(".rd-themed > summary");
      await page.click(`.rd-thememenu form:has(input[value="${theme}"]) button`);
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.rdMutationPending !== "true",
      );
    };
    try {
      const initial = await makeIpacRecoveryOrphan(page);
      await initial.sheet.locator('[data-nx="rd-recovery-close"]').click();
      await page.route("**/api/redesign*", handler);
      await repaint("matrix");

      const attention = page.locator("[data-rd-attention]:visible");
      await attention.waitFor({ state: "visible" });
      assert.equal(
        await attention.locator('[data-nx="rd-refresh-retry"]').isVisible(),
        true,
        "the simulated capture outage exposes its retry action",
      );
      await attention.locator('[data-nx="rd-review-recovery"]').click();
      const sheet = page.locator("[data-rd-recovery-sheet]:visible");
      const sheetRow = sheet.locator(`.rd-held-row[data-held-selector="${IPAC}"]`);
      await sheetRow.waitFor({ state: "visible" });
      await page.waitForFunction(
        (selector) => document.activeElement?.matches(
          `.rd-held-row[data-held-selector="${selector}"]`,
        ),
        IPAC,
      );

      identityComplete = false;
      heldNote = "Exact Windows identity is temporarily ambiguous.";
      await page.waitForFunction(() => {
        const row = document.querySelector("[data-rd-recovery-sheet] .rd-held-row[data-held-key]");
        return row?.getAttribute("data-held-selector") === "" &&
          row?.textContent?.includes("temporarily ambiguous");
      }, null, { timeout: 8_000 });
      const ambiguousRow = sheet.locator(".rd-held-row[data-held-key]").first();
      assert.equal(
        await ambiguousRow.evaluate((row) => document.activeElement === row),
        true,
        "identity-incomplete held recovery preserves focus by its stable server key",
      );
      identityComplete = true;
      heldNote = "Release this exact prepared input.";
      await page.waitForFunction(
        (selector) => document.querySelector(
          `[data-rd-recovery-sheet] .rd-held-row[data-held-selector="${selector}"]`,
        ),
        IPAC,
        { timeout: 8_000 },
      );
      assert.equal(
        await sheetRow.evaluate((row) => document.activeElement === row),
        true,
        "restored exact identity keeps focus on the same held-device row",
      );

      releaseAllowed = false;
      heldNote = "Release authority is temporarily unavailable.";
      await page.waitForFunction(
        (selector) => document.querySelector(
          `.rd-held-row[data-held-selector="${selector}"]`,
        )?.textContent?.includes("temporarily unavailable"),
        IPAC,
        { timeout: 8_000 },
      );
      const nativeRow = page.locator(
        `.rd-capture-native .rd-held-row:has(input[value="${IPAC}"])`,
      );
      for (const row of [sheetRow, nativeRow]) {
        assert.equal(await row.locator('button[type="submit"]').isDisabled(), true);
        assert.equal(
          await row.locator('input[name="confirm_release"]').isDisabled(),
          true,
          "an unavailable release cannot leave actionable-looking consent behind",
        );
        assert.match((await row.textContent()) ?? "", /temporarily unavailable/i);
      }
      assert.equal(
        await sheetRow.evaluate((row) => document.activeElement === row),
        true,
        "a passive status repaint preserves the exact held row that owned focus",
      );
      await sheet.locator('[data-nx="rd-recovery-close"]').click();
      await sheet.waitFor({ state: "hidden" });
      await attention.locator('[data-nx="rd-review-recovery"]').click();
      await sheet.waitFor({ state: "visible" });
      await page.waitForFunction(
        (selector) => document.activeElement?.matches(
          `.rd-held-row[data-held-selector="${selector}"]`,
        ),
        IPAC,
      );
      assert.equal(
        await sheetRow.evaluate((row) => document.activeElement === row),
        true,
        "manual recovery remains reachable when automatic Release is unsafe",
      );

      releaseAllowed = true;
      heldNote = "Exact Windows identity verified again.";
      await page.waitForFunction(
        (selector) => document.querySelector(
          `.rd-held-row[data-held-selector="${selector}"]`,
        )?.textContent?.includes("identity verified again"),
        IPAC,
        { timeout: 8_000 },
      );
      for (const row of [sheetRow, nativeRow]) {
        assert.equal(await row.locator('button[type="submit"]').isEnabled(), true);
        assert.equal(await row.locator('input[name="confirm_release"]').isEnabled(), true);
        assert.match((await row.textContent()) ?? "", /identity verified again/i);
      }

      const release = sheetRow.locator('[data-rd-form="capture-release"]');
      await release.locator('input[name="confirm_release"]').check();
      await release.locator('button[type="submit"]').click();
      await sheet.waitFor({ state: "hidden", timeout: 20_000 });
      released = true;
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseAllowed = true;
      identityComplete = true;
      if (!released && !page.isClosed()) {
        await page.evaluate(async (selector) => {
          const form = Array.from(document.querySelectorAll(
            '[data-rd-form="capture-release"]',
          )).find((candidate) =>
            candidate.querySelector('input[name="expected_selector"]')?.value === selector
          );
          if (!form) return;
          const body = new URLSearchParams(new FormData(form));
          body.set("confirm_release", "yes");
          await fetch(form.action, { method: "POST", body, redirect: "manual" });
        }, IPAC).catch(() => {});
      }
      await page.unroute("**/api/redesign*", handler).catch(() => {});
      if (!page.isClosed()) await page.close();
    }
  });
});
