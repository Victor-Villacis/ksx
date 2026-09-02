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
const ABANDONED_IDENTIFY_KEY = "ksx-redesign-identify-abandoned-attempt";
const FENCED_LIFECYCLE_SELECTOR =
  '[data-rd-form="save"] button[type="submit"], ' +
  '[data-rd-form="play"] button[type="submit"]';

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

async function removeStagedSource(base, selector) {
  const response = await fetch(`${base}/redesign/device/remove`, {
    method: "POST",
    body: new URLSearchParams({ selector, confirm_remove: "on" }),
    redirect: "manual",
  });
  assert.equal(response.status, 303, `could not remove ${selector} on ${base}`);
}

async function resetStagedSources(base) {
  const payload = await fetch(`${base}/api/redesign`).then((response) => response.json());
  const selectors = new Set([
    ...payload.devices.keyboards,
    ...payload.devices.encoders,
    ...payload.devices.experimental,
  ].filter((row) => row.aria_current === "true").map((row) => row.selector));
  for (const selector of selectors) {
    await removeStagedSource(base, selector);
  }
}

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForListeningGeneration(base, previous = null, deadlineMs = 15_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const view = await fetch(`${base}/api/learn`).then((response) => response.json());
    if (
      view.state === "listening" &&
      Number.isInteger(view.generation) &&
      view.generation !== previous
    ) {
      return view.generation;
    }
    if (Date.now() > until) {
      throw new Error(`fixture did not acquire a new learner generation on ${base}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function lifecycleFenceSnapshot(page) {
  return page.locator(FENCED_LIFECYCLE_SELECTOR).evaluateAll((buttons) =>
    buttons.map((button) => ({
      kind: button.closest("form")?.getAttribute("data-rd-form") ?? "",
      disabled: button.disabled,
    }))
  );
}

function assertNoUnexpectedNoise(page, allowed) {
  const unexpected = page.ksxNoise.filter((line) =>
    !allowed.some((pattern) => pattern.test(line))
  );
  assert.deepEqual(unexpected, []);
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
    await resetStagedSources(BASE);
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
              connection_label: "USB D209:0430 · connection 01",
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
      assert.deepEqual(
        await page.locator(".rd-dev-identity", { hasText: "USB D209:0430" }).allTextContents(),
        ["USB D209:0430 · connection 00", "USB D209:0430 · connection 01"],
        "true twin boards keep distinct connection labels beside the shared name",
      );
      const action = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      assert.match(
        (await page.locator("[data-rd-identify] .rd-identify-copy").textContent()) ?? "",
        /successful answer adds that exact connection as an independent source.*nothing is captured, saved, or started/is,
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
        /USB D209:0430 · connection 00.*exact connection.*independent mapping source/i,
      );
      assert.equal(
        await page.locator(`.rd-devmodal [data-selector="${IPAC}"][aria-current="true"]`).count(),
        1,
        "the daemon-resolved selector, not the duplicated name, owns the staged mark",
      );
      assert.equal(
        await page.locator(`.rd-devmodal [data-selector="${G915}"][aria-current="true"]`).count(),
        1,
        "identify adds the exact answer without replacing a peer source",
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

  test("a request failure re-reads authority and never promises that nothing changed", async () => {
    await resetStagedSources(BASE);
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(BASE);
    try {
      await page.route(`${BASE}/redesign/device/identify`, (route) =>
        route.fulfill({ status: 503, body: "fixture refusal" })
      );
      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      await action.click();
      const status = page.locator('[data-rd-identify-status][data-state="error"]');
      await status.waitFor();
      assert.match(
        (await status.textContent()) ?? "",
        /could not confirm.*review the mapping-source list.*reload/is,
      );
      assert.doesNotMatch((await status.textContent()) ?? "", /nothing changed/i);
      assert.equal(await page.locator(".rd-devmodal[hidden]").count(), 0);
      assert.equal(await action.evaluate((button) => button === document.activeElement), true);
      // Chromium reports an intentionally-authored failed fetch in the
      // console even though the product catches it and performs recovery.
      assertNoUnexpectedNoise(page, [
        /^console: Failed to load resource:.*status of 503\b/i,
      ]);
    } finally {
      await page.close();
    }
  });

  test("a lost response refreshes authority without attributing any staged row", async () => {
    await resetStagedSources(BASE);
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(BASE);
    try {
      await page.route(`${BASE}/redesign/device/identify`, async (route) => {
        const committed = await route.fetch({ maxRedirects: 0 });
        assert.equal(committed.status(), 303, "the fixture did not commit before response loss");
        await route.abort("connectionclosed");
      });
      await page.click('[data-nx="rd-devs-open"]');
      await page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      }).click();

      const status = page.locator('[data-rd-identify-status][data-state="error"]');
      await status.waitFor({ timeout: 15_000 });
      assert.match(
        (await status.textContent()) ?? "",
        /Could not confirm.*review the mapping-source list.*reload/is,
      );
      assert.equal(
        await page.locator(`.rd-devmodal [data-selector="${IPAC}"][aria-current="true"]`).count(),
        1,
      );
      assert.equal(
        await page.locator(`.rd-devmodal [data-selector="${G915}"][aria-current="true"]`).count(),
        1,
        "a lost response cannot silently replace the previously focused source",
      );
      assert.doesNotMatch((await status.textContent()) ?? "", /nothing changed/i);
      assert.doesNotMatch((await status.textContent()) ?? "", /Identified Ultimarc/i);
      // Aborting the routed response is the test's transport-loss mechanism;
      // Chromium's network diagnostic is expected, application errors are not.
      assertNoUnexpectedNoise(page, [
        /^console: Failed to load resource:.*ERR_CONNECTION_CLOSED\b/i,
      ]);
    } finally {
      await page.close();
    }
  });

  test("a settled answer retires Cancel before a slow authority refresh", async () => {
    await resetStagedSources(BASE);
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(BASE);
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    let reportRefreshStarted;
    const refreshStarted = new Promise((resolve) => {
      reportRefreshStarted = resolve;
    });
    let gateNextRefresh = false;
    let cancelRequests = 0;
    try {
      page.on("request", (request) => {
        if (
          request.method() === "POST"
          && request.url() === `${BASE}/redesign/device/identify/cancel`
        ) cancelRequests += 1;
      });
      await page.route(`${BASE}/redesign/device/identify`, (route) => {
        gateNextRefresh = true;
        return route.continue();
      });
      await page.route(`${BASE}/api/redesign*`, async (route) => {
        if (!gateNextRefresh) return route.continue();
        gateNextRefresh = false;
        reportRefreshStarted();
        await refreshGate;
        return route.continue();
      });

      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      await action.click();
      await within(
        refreshStarted,
        15_000,
        "the settled identify response never started its authority refresh",
      );

      const resolving = page.locator('[data-rd-identify-status][data-state="resolving"]');
      await resolving.waitFor();
      assert.match((await resolving.textContent()) ?? "", /Keyboard answered.*Confirming/is);
      assert.equal(
        await page.locator(".rd-devmodal").getAttribute("data-rd-identify-pending"),
        null,
        "the browser still claimed ownership of the next physical key",
      );
      assert.equal(
        await page.locator("[data-rd-identify-cancel]").isHidden(),
        true,
        "Cancel remained offered after the answer committed",
      );
      assert.equal(
        await action.isDisabled(),
        true,
        "Identify re-enabled before the answer's authority repaint settled",
      );

      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      assert.equal(cancelRequests, 0, "Escape sent a contradictory late cancellation");
      releaseRefresh();

      await page.locator('[data-rd-identify-status][data-state="identified"]').waitFor({
        state: "attached",
        timeout: 15_000,
      });
      const payload = await fetch(`${BASE}/api/redesign`).then((response) => response.json());
      const staged = new Set([...payload.devices.keyboards, ...payload.devices.encoders]
        .filter((row) => row.aria_current === "true")
        .map((row) => row.selector));
      assert.deepEqual(
        staged,
        new Set([G915, IPAC]),
        "the committed answer must join, never replace, the peer source",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseRefresh?.();
      await page.close();
    }
  });

  test("a concurrently removed answer cannot be mislabeled as identified", async () => {
    await resetStagedSources(BASE);
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(BASE);
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    let reportRefreshStarted;
    const refreshStarted = new Promise((resolve) => {
      reportRefreshStarted = resolve;
    });
    let gateNextRefresh = false;
    let omitAnsweredSource = false;
    try {
      await page.route(`${BASE}/redesign/device/identify`, (route) => {
        gateNextRefresh = true;
        return route.continue();
      });
      await page.route(`${BASE}/api/redesign*`, async (route) => {
        if (!gateNextRefresh) return route.continue();
        gateNextRefresh = false;
        reportRefreshStarted();
        await refreshGate;
        const response = await route.fetch();
        const payload = await response.json();
        if (omitAnsweredSource) {
          for (const tier of ["keyboards", "encoders", "experimental"]) {
            payload.devices[tier] = payload.devices[tier]
              .filter((row) => row.selector !== IPAC);
          }
        }
        return route.fulfill({ response, json: payload });
      });

      await page.click('[data-nx="rd-devs-open"]');
      await page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      }).click();
      await within(
        refreshStarted,
        15_000,
        "the identified selector never reached its authority refresh",
      );

      // The answer additively staged IPAC, but another client removes that
      // exact source before this page can confirm it. The existing G915 peer
      // remains staged and must never be mislabeled as the answer.
      omitAnsweredSource = true;
      releaseRefresh();

      const status = page.locator('[data-rd-identify-status][data-state="error"]');
      await status.waitFor({ timeout: 15_000 });
      assert.match(
        (await status.textContent()) ?? "",
        /Keyboard answered.*source not confirmed.*Ultimarc I-PAC 4.*answered this attempt.*no longer present/is,
      );
      assert.doesNotMatch((await status.textContent()) ?? "", /Identified Logitech/i);
      assert.equal(
        await page.locator(`.rd-devmodal [data-selector="${G915}"][aria-current="true"]`).count(),
        1,
        "the refreshed current row did not preserve the concurrent authority",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseRefresh?.();
      await page.close();
    }
  });

  test("the native no-script identify form is reachable and completes the same transaction", async () => {
    await resetStagedSources(BASE);
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      const fallback = page.locator(".rd-identify-native");
      assert.equal(await fallback.isVisible(), true, "the no-script action is not reachable");
      assert.match(
        (await fallback.textContent()) ?? "",
        /successful answer adds that connection as an independent mapping source.*nothing is captured, saved, or started/is,
      );
      await Promise.all([
        page.waitForURL((url) =>
          url.pathname === "/redesign"
            && url.searchParams.get("flash") === "Keyboard identified and selected. Nothing has been captured, saved, or started."
        ),
        fallback.getByRole("button", {
          name: "Identify exact device",
          exact: true,
        }).click(),
      ]);

      const payload = await fetch(`${BASE}/api/redesign`).then((response) => response.json());
      const staged = new Set([...payload.devices.keyboards, ...payload.devices.encoders]
        .filter((row) => row.aria_current === "true")
        .map((row) => row.selector));
      assert.deepEqual(
        staged,
        new Set([G915, IPAC]),
        "the native form adds the exact answer without replacing its peer",
      );
      assert.equal(
        new URL(page.url()).searchParams.get("identified_selector"),
        IPAC,
        "the native redirect discloses the exact connection that answered",
      );
    } finally {
      await context.close();
    }
  });

  test("Escape cancels the exact pending listener, guards browser keys, and preserves the old input", async () => {
    await resetStagedSources(HOLD_BASE);
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      await action.click();
      const pending = page.locator('[data-rd-identify-status][data-state="listening"]');
      await pending.waitFor();
      assert.equal(
        await pending.evaluate((status) => status === document.activeElement),
        true,
        "the instructions receive focus; a button whose Enter/Space are identification keys must not",
      );
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
        "Space ended identification instead of being guarded",
      );
      assert.equal(
        await pending.evaluate((status) => status === document.activeElement),
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

  test("the exact cancel result wins when the held start response returns first", async () => {
    await resetStagedSources(HOLD_BASE);
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    let releaseCancellation;
    const cancellationGate = new Promise((resolve) => {
      releaseCancellation = resolve;
    });
    try {
      // Mark when the application has actually received the held start
      // response. A network response event alone fires before the awaiting
      // submit handler resumes and would not prove this ordering.
      await page.evaluate(() => {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await nativeFetch(...args);
          const input = args[0];
          const href = input instanceof Request ? input.url : String(input);
          if (new URL(href, location.href).pathname === "/redesign/device/identify") {
            document.documentElement.dataset.testIdentifyResponse = "delivered";
          }
          return response;
        };
      });
      await page.route(`${HOLD_BASE}/redesign/device/identify/cancel`, async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        assert.equal(response.status(), 303, "the exact cancellation did not settle");
        await cancellationGate;
        await route.fulfill({ response });
      });

      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      await action.click();
      await page.locator('[data-rd-identify-status][data-state="listening"]').waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.documentElement.dataset.testIdentifyResponse === "delivered",
        null,
        { timeout: 15_000 },
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(
        await page.locator(".rd-devmodal").getAttribute("data-rd-identify-pending"),
        "true",
        "the start response retired the nonce before its exact cancellation settled",
      );
      const cancellationDelivered = page.waitForResponse((response) =>
        response.url().includes("/redesign?flash=Keyboard%20identification%20cancelled")
      );
      releaseCancellation();
      await within(
        cancellationDelivered,
        15_000,
        "the released cancellation response did not reach the browser",
      );

      const cancelled = page.locator('[data-rd-identify-status][data-state="cancelled"]');
      await cancelled.waitFor({ timeout: 15_000 });
      assert.match((await cancelled.textContent()) ?? "", /cancelled.*Nothing changed/is);
      assert.equal(await action.evaluate((button) => button === document.activeElement), true);
      const payload = await fetch(`${HOLD_BASE}/api/redesign`).then((response) => response.json());
      const current = [...payload.devices.keyboards, ...payload.devices.encoders]
        .find((row) => row.aria_current === "true");
      assert.equal(current?.selector, G915, "cancel must preserve the prior mapping input");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseCancellation?.();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  test("leaving the page cancels its exact listener before another attempt starts", async () => {
    await resetStagedSources(HOLD_BASE);
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    let releaseCleanup;
    let releaseAuthority;
    try {
      const lifecycleBaseline = await lifecycleFenceSnapshot(page);
      assert.ok(lifecycleBaseline.length > 0, "the fixture exposed no Save or Play action");
      await page.click('[data-nx="rd-devs-open"]');
      await page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      }).click();
      await page.locator('[data-rd-identify-status][data-state="listening"]').waitFor();

      const firstGeneration = await waitForListeningGeneration(HOLD_BASE);
      // Deterministically reproduce the browser race: claim the unload beacon
      // was queued without delivering it. The next document must recover the
      // exact nonce through sessionStorage before it starts another listener.
      await page.evaluate(() => {
        Object.defineProperty(navigator, "sendBeacon", {
          configurable: true,
          value: (url) =>
            new URL(String(url), window.location.href).pathname ===
              "/redesign/device/identify/cancel",
        });
      });

      await page.goto(`${HOLD_BASE}/check`, { waitUntil: "domcontentloaded" });
      const abandonedAttempt = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        ABANDONED_IDENTIFY_KEY,
      );
      assert.match(abandonedAttempt ?? "", /^[a-f0-9]{32}$/);

      const handoffRequests = [];
      page.on("request", (request) => {
        if (request.method() !== "POST") return;
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith("/redesign/device/identify")) return;
        const body = new URLSearchParams(request.postData() ?? "");
        handoffRequests.push({ pathname, attempt: body.get("attempt") });
      });
      let reportCleanupSeen;
      const cleanupSeen = new Promise((resolve) => {
        reportCleanupSeen = resolve;
      });
      const cleanupGate = new Promise((resolve) => {
        releaseCleanup = resolve;
      });
      let cleanupReleased = false;
      await page.route(`${HOLD_BASE}/redesign/device/identify/cancel`, async (route) => {
        const body = new URLSearchParams(route.request().postData() ?? "");
        if (body.get("attempt") === abandonedAttempt) {
          reportCleanupSeen();
          await cleanupGate;
        }
        await route.continue();
      });
      let reportAuthoritySeen;
      const authoritySeen = new Promise((resolve) => {
        reportAuthoritySeen = resolve;
      });
      const authorityGate = new Promise((resolve) => {
        releaseAuthority = resolve;
      });
      let authorityHeld = false;
      await page.route(`${HOLD_BASE}/api/redesign*`, async (route) => {
        if (!cleanupReleased || authorityHeld) {
          await route.continue();
          return;
        }
        authorityHeld = true;
        reportAuthoritySeen();
        await authorityGate;
        await route.continue();
      });

      await page.goto(`${HOLD_BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await within(
        cleanupSeen,
        15_000,
        "the restored document never began exact-nonce cleanup",
      );
      const rescan = page.locator('[data-nx="rd-rescan"]');
      assert.equal(
        await rescan.isDisabled(),
        true,
        "hydration cleanup left Rescan available before exact cancellation settled",
      );
      assert.ok(
        (await lifecycleFenceSnapshot(page)).every((action) => action.disabled),
        "hydration cleanup did not fence every Save and Play action",
      );
      await page.click('[data-nx="rd-devs-open"]');
      const retry = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      const deviceToggle = page.locator('[data-nx="rd-dev-toggle"]').first();
      assert.equal(
        await retry.isDisabled(),
        true,
        "hydration cleanup left Identify available before exact cancellation settled",
      );
      assert.equal(
        await deviceToggle.isDisabled(),
        true,
        "hydration cleanup left device placement available before exact cancellation settled",
      );
      cleanupReleased = true;
      releaseCleanup();
      await within(
        authoritySeen,
        15_000,
        "exact-nonce cleanup never reached its authority repaint",
      );
      await page.locator('[data-rd-identify-status][data-state="resolving"]').waitFor();
      assert.equal(await rescan.isDisabled(), true);
      assert.ok((await lifecycleFenceSnapshot(page)).every((action) => action.disabled));
      assert.equal(await retry.isDisabled(), true);
      assert.equal(await deviceToggle.isDisabled(), true);
      assert.equal(
        handoffRequests.some((entry) => entry.pathname === "/redesign/device/identify"),
        false,
        "Identify started while abandoned exact-nonce cleanup was still pending",
      );
      const retiredBeforeRetry = await fetch(`${HOLD_BASE}/api/learn`).then((response) =>
        response.json()
      );
      assert.equal(retiredBeforeRetry.state, "idle");
      assert.equal(retiredBeforeRetry.generation, null);

      releaseAuthority();
      await page.locator('[data-rd-identify-status][data-state="idle"]').waitFor();
      assert.equal(
        handoffRequests.some((entry) => entry.pathname === "/redesign/device/identify"),
        false,
        "the pre-navigation click resumed into a listener without a new user action",
      );
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
      );
      assert.equal(await rescan.isEnabled(), true);
      assert.deepEqual(await lifecycleFenceSnapshot(page), lifecycleBaseline);
      assert.equal(await retry.isEnabled(), true);
      assert.equal(await deviceToggle.isEnabled(), true);
      await retry.click();
      const listening = page.locator('[data-rd-identify-status][data-state="listening"]');
      await listening.waitFor();
      const secondGeneration = await waitForListeningGeneration(HOLD_BASE, firstGeneration);
      assert.notEqual(
        secondGeneration,
        firstGeneration,
        "the fixture reused the abandoned generation",
      );
      assert.equal(await listening.count(), 1, "the recovered listener did not remain live");
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
      );

      const cleanupIndex = handoffRequests.findIndex((entry) =>
        entry.pathname === "/redesign/device/identify/cancel" &&
        entry.attempt === abandonedAttempt
      );
      const nextStartIndex = handoffRequests.findIndex((entry) =>
        entry.pathname === "/redesign/device/identify" &&
        entry.attempt !== abandonedAttempt
      );
      assert.notEqual(
        cleanupIndex,
        -1,
        "the next document never retired the abandoned exact nonce",
      );
      assert.ok(
        nextStartIndex > cleanupIndex,
        "the new Identify request overtook the abandoned exact-nonce cleanup",
      );
      await page.keyboard.press("Escape");
      await page.locator('[data-rd-identify-status][data-state="cancelled"]').waitFor({
        timeout: 15_000,
      });

      const payload = await fetch(`${HOLD_BASE}/api/redesign`).then((response) => response.json());
      const current = [...payload.devices.keyboards, ...payload.devices.encoders]
        .find((row) => row.aria_current === "true");
      assert.equal(current?.selector, G915, "navigation cleanup changed the mapping input");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseCleanup?.();
      releaseAuthority?.();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  test("a failed navigation cleanup keeps its exact nonce and retries before listening", async () => {
    await resetStagedSources(HOLD_BASE);
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    let releaseFailure;
    let releaseRetryCleanup;
    try {
      const lifecycleBaseline = await lifecycleFenceSnapshot(page);
      assert.ok(lifecycleBaseline.length > 0, "the fixture exposed no Save or Play action");
      await page.click('[data-nx="rd-devs-open"]');
      await page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      }).click();
      await page.locator('[data-rd-identify-status][data-state="listening"]').waitFor();
      const firstGeneration = await waitForListeningGeneration(HOLD_BASE);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "sendBeacon", {
          configurable: true,
          value: (url) =>
            new URL(String(url), window.location.href).pathname ===
              "/redesign/device/identify/cancel",
        });
      });
      await page.goto(`${HOLD_BASE}/check`, { waitUntil: "domcontentloaded" });
      const abandonedAttempt = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        ABANDONED_IDENTIFY_KEY,
      );
      assert.match(abandonedAttempt ?? "", /^[a-f0-9]{32}$/);

      const starts = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/redesign/device/identify"
        ) starts.push(request.postData());
      });
      let reportCleanupSeen;
      const cleanupSeen = new Promise((resolve) => {
        reportCleanupSeen = resolve;
      });
      const failureGate = new Promise((resolve) => {
        releaseFailure = resolve;
      });
      await page.route(`${HOLD_BASE}/redesign/device/identify/cancel`, async (route) => {
        const body = new URLSearchParams(route.request().postData() ?? "");
        if (body.get("attempt") !== abandonedAttempt) {
          await route.continue();
          return;
        }
        reportCleanupSeen();
        await failureGate;
        await route.abort("failed");
      });

      await page.goto(`${HOLD_BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await within(cleanupSeen, 15_000, "the foreground cleanup was never attempted");
      await page.click('[data-nx="rd-devs-open"]');
      const retry = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      assert.equal(await retry.isDisabled(), true);
      assert.equal(await page.locator('[data-nx="rd-rescan"]').isDisabled(), true);
      assert.ok(
        (await lifecycleFenceSnapshot(page)).every((action) => action.disabled),
        "hydration cleanup did not fence every Save and Play action",
      );
      assert.equal(await page.locator('[data-nx="rd-dev-toggle"]').first().isDisabled(), true);
      await page.locator('[data-rd-identify-status][data-state="resolving"]').waitFor();
      releaseFailure();

      const error = page.locator('[data-rd-identify-status][data-state="error"]');
      await error.waitFor();
      assert.match((await error.textContent()) ?? "", /previous listener still needs attention/i);
      assert.deepEqual(await lifecycleFenceSnapshot(page), lifecycleBaseline);
      assert.equal(starts.length, 0, "cleanup failure still opened a new listener");
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        abandonedAttempt,
        "failed cleanup forgot the only exact owner available for retry",
      );
      const stillListening = await fetch(`${HOLD_BASE}/api/learn`).then((response) =>
        response.json()
      );
      assert.equal(stillListening.generation, firstGeneration);

      await page.unrouteAll({ behavior: "wait" });
      let reportRetryCleanupSeen;
      const retryCleanupSeen = new Promise((resolve) => {
        reportRetryCleanupSeen = resolve;
      });
      const retryCleanupGate = new Promise((resolve) => {
        releaseRetryCleanup = resolve;
      });
      await page.route(`${HOLD_BASE}/redesign/device/identify/cancel`, async (route) => {
        const body = new URLSearchParams(route.request().postData() ?? "");
        if (body.get("attempt") === abandonedAttempt) {
          reportRetryCleanupSeen();
          await retryCleanupGate;
        }
        await route.continue();
      });
      await retry.click();
      await within(
        retryCleanupSeen,
        15_000,
        "the explicit retry never resumed exact-nonce cleanup",
      );
      await page.locator('[data-rd-identify-status][data-state="resolving"]').waitFor();
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      assert.equal(
        await page.locator('[data-nx="rd-rescan"]').isDisabled(),
        true,
        "BFCache recovery released the inherited preflight mutation lock",
      );
      assert.ok((await lifecycleFenceSnapshot(page)).every((action) => action.disabled));
      releaseRetryCleanup();
      await page.locator('[data-rd-identify-status][data-state="idle"]').waitFor();
      assert.equal(
        starts.length,
        0,
        "the pre-BFCache click resumed into a listener without a new user action",
      );
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
      );
      assert.deepEqual(await lifecycleFenceSnapshot(page), lifecycleBaseline);
      await retry.click();
      await page.locator('[data-rd-identify-status][data-state="listening"]').waitFor();
      const secondGeneration = await waitForListeningGeneration(HOLD_BASE, firstGeneration);
      assert.notEqual(secondGeneration, firstGeneration);
      assert.equal(starts.length, 1, "retry did not open exactly one new listener");
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
      );
      await page.keyboard.press("Escape");
      await page.locator('[data-rd-identify-status][data-state="cancelled"]').waitFor({
        timeout: 15_000,
      });
      assertNoUnexpectedNoise(page, [/Failed to load resource: net::ERR_FAILED/]);
    } finally {
      releaseFailure?.();
      releaseRetryCleanup?.();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  test("a BFCache restore after failed hydration cleanup reacquires the island fence", async () => {
    await resetStagedSources(HOLD_BASE);
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    let releaseFailure;
    let releaseRecovery;
    try {
      const lifecycleBaseline = await lifecycleFenceSnapshot(page);
      assert.ok(lifecycleBaseline.length > 0, "the fixture exposed no Save or Play action");
      await page.click('[data-nx="rd-devs-open"]');
      await page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      }).click();
      await page.locator('[data-rd-identify-status][data-state="listening"]').waitFor();
      const firstGeneration = await waitForListeningGeneration(HOLD_BASE);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "sendBeacon", {
          configurable: true,
          value: (url) =>
            new URL(String(url), window.location.href).pathname ===
              "/redesign/device/identify/cancel",
        });
      });
      await page.goto(`${HOLD_BASE}/check`, { waitUntil: "domcontentloaded" });
      const abandonedAttempt = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        ABANDONED_IDENTIFY_KEY,
      );
      assert.match(abandonedAttempt ?? "", /^[a-f0-9]{32}$/);

      const starts = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/redesign/device/identify"
        ) starts.push(request.postData());
      });
      let reportFailureSeen;
      const failureSeen = new Promise((resolve) => {
        reportFailureSeen = resolve;
      });
      const failureGate = new Promise((resolve) => {
        releaseFailure = resolve;
      });
      let reportRecoverySeen;
      const recoverySeen = new Promise((resolve) => {
        reportRecoverySeen = resolve;
      });
      const recoveryGate = new Promise((resolve) => {
        releaseRecovery = resolve;
      });
      let firstCleanup = true;
      await page.route(`${HOLD_BASE}/redesign/device/identify/cancel`, async (route) => {
        const body = new URLSearchParams(route.request().postData() ?? "");
        if (body.get("attempt") !== abandonedAttempt) {
          await route.continue();
          return;
        }
        if (firstCleanup) {
          firstCleanup = false;
          reportFailureSeen();
          await failureGate;
          await route.abort("failed");
          return;
        }
        reportRecoverySeen();
        await recoveryGate;
        await route.continue();
      });

      await page.goto(`${HOLD_BASE}/redesign`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await within(failureSeen, 15_000, "hydration cleanup never reached the failure gate");
      await page.click('[data-nx="rd-devs-open"]');
      releaseFailure();
      await page.locator('[data-rd-identify-status][data-state="error"]').waitFor();
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        abandonedAttempt,
      );
      assert.equal(await page.locator('[data-nx="rd-rescan"]').isEnabled(), true);
      assert.deepEqual(await lifecycleFenceSnapshot(page), lifecycleBaseline);

      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await within(
        recoverySeen,
        15_000,
        "BFCache recovery did not retry the failed exact-nonce cleanup",
      );
      await page.locator('[data-rd-identify-status][data-state="resolving"]').waitFor();
      assert.equal(
        await page.locator('[data-nx="rd-rescan"]').isDisabled(),
        true,
        "BFCache retry left Rescan available without an inherited identify lease",
      );
      assert.ok(
        (await lifecycleFenceSnapshot(page)).every((action) => action.disabled),
        "BFCache retry did not fence every Save and Play action",
      );
      const retry = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      assert.equal(await retry.isDisabled(), true);
      assert.equal(await page.locator('[data-nx="rd-dev-toggle"]').first().isDisabled(), true);
      assert.equal(starts.length, 0, "BFCache cleanup opened a listener without user intent");

      releaseRecovery();
      await page.locator('[data-rd-identify-status][data-state="idle"]').waitFor();
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
      );
      assert.equal(await page.locator('[data-nx="rd-rescan"]').isEnabled(), true);
      assert.deepEqual(await lifecycleFenceSnapshot(page), lifecycleBaseline);
      assert.equal(await retry.isEnabled(), true);
      assert.equal(await page.locator('[data-nx="rd-dev-toggle"]').first().isEnabled(), true);
      assert.equal(starts.length, 0, "BFCache cleanup implicitly restarted identification");
      const learner = await fetch(`${HOLD_BASE}/api/learn`).then((response) => response.json());
      assert.equal(learner.state, "idle");
      assert.equal(learner.generation, null);
      assert.notEqual(firstGeneration, null);
      assertNoUnexpectedNoise(page, [/Failed to load resource: net::ERR_FAILED/]);
    } finally {
      releaseFailure?.();
      releaseRecovery?.();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  test("a BFCache restore replaces its dead listening UI with recovered truth", async () => {
    await resetStagedSources(HOLD_BASE);
    await stage(HOLD_BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(HOLD_BASE);
    let releaseRecovery;
    try {
      await page.click('[data-nx="rd-devs-open"]');
      const action = page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      });
      await action.click();
      await page.locator('[data-rd-identify-status][data-state="listening"]').waitFor();
      await waitForListeningGeneration(HOLD_BASE);
      let reportRecoverySeen;
      const recoverySeen = new Promise((resolve) => {
        reportRecoverySeen = resolve;
      });
      const recoveryGate = new Promise((resolve) => {
        releaseRecovery = resolve;
      });
      await page.route(`${HOLD_BASE}/redesign/device/identify/cancel`, async (route) => {
        reportRecoverySeen();
        await recoveryGate;
        await route.continue();
      });
      await page.evaluate(() => {
        Object.defineProperty(navigator, "sendBeacon", {
          configurable: true,
          value: (url) =>
            new URL(String(url), window.location.href).pathname ===
              "/redesign/device/identify/cancel",
        });
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await within(recoverySeen, 15_000, "BFCache recovery never sent its exact cleanup");
      const restoring = page.locator('[data-rd-identify-status][data-state="resolving"]');
      await restoring.waitFor();
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      assert.equal(
        await page.locator(".rd-devmodal").getAttribute("data-rd-identify-pending"),
        "true",
        "the aborted old request removed the restored document's pending fence",
      );
      assert.equal(await action.isDisabled(), true);
      assert.equal(
        await restoring.evaluate((element) => element === document.activeElement),
        true,
        "the aborted old request moved focus away from recovery status",
      );
      assert.equal(
        await page.locator('[data-nx="rd-rescan"]').isDisabled(),
        true,
        "BFCache recovery released the inherited island mutation lock",
      );
      const fit = page.locator('button.n-autobtn[data-nx="canvas-fit"]');
      await fit.focus();
      assert.equal(await fit.evaluate((element) => element === document.activeElement), true);
      releaseRecovery();

      const recovered = page.locator('[data-rd-identify-status][data-state="idle"]');
      await recovered.waitFor({ timeout: 15_000 });
      assert.match((await recovered.textContent()) ?? "", /previous exact listener is stopped/i);
      assert.equal(
        await page.locator("[data-rd-identify-cancel]").isHidden(),
        true,
        "the restored document left a dead Cancel control visible",
      );
      assert.equal(await fit.evaluate((element) => element === document.activeElement), true);
      assert.notEqual(
        await page.locator(".rd-devmodal").getAttribute("data-rd-identify-pending"),
        "true",
      );
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
      );
      const learner = await fetch(`${HOLD_BASE}/api/learn`).then((response) => response.json());
      assert.equal(learner.state, "idle");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      releaseRecovery?.();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  test("an abandoned answer refreshes authority before its nonce is forgotten", async () => {
    await resetStagedSources(BASE);
    await stage(BASE, G915, "g915", "Logitech G915 TKL");
    const page = await openRedesign(BASE);
    try {
      let attempt = "";
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/redesign/device/identify"
        ) {
          attempt = new URLSearchParams(request.postData() ?? "").get("attempt") ?? "";
        }
      });
      await page.click('[data-nx="rd-devs-open"]');
      await page.getByRole("button", {
        name: "Identify exact device",
        exact: true,
      }).click();
      await page.locator('[data-rd-identify-status][data-state="identified"]').waitFor({
        timeout: 15_000,
      });
      assert.match(attempt, /^[a-f0-9]{32}$/);
      // Recreate the next-document cleanup after the original response has
      // fully retired. This uses the real server tombstone; a mocked redirect
      // cannot prove that completed answers remain distinguishable from
      // Cancel-before-Start.
      await page.evaluate(
        ({ key, value }) => sessionStorage.setItem(key, value),
        { key: ABANDONED_IDENTIFY_KEY, value: attempt },
      );
      let authorityReads = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/redesign") authorityReads += 1;
      });

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-rd-identify-status]")?.dataset.state === "identified",
        null,
        { timeout: 15_000 },
      );
      const recovered = page.locator('[data-rd-identify-status][data-state="identified"]');
      assert.match((await recovered.textContent()) ?? "", /previous keyboard check finished/i);
      assert.ok(authorityReads >= 1, "already-answered cleanup skipped its authority repaint");
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), ABANDONED_IDENTIFY_KEY),
        null,
        "the exact nonce remained after its answer and current authority were both confirmed",
      );
      assert.match(await page.locator(".rd-flash").textContent(), /mapping sources are now up to date/i);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });
});
