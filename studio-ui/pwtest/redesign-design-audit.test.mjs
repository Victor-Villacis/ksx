// Focused browser contracts for the design-audit polish. These assertions
// intentionally cover behavior and accessibility semantics together: the
// narrow rail, empty-workbench invitation, discoverable unavailable actions,
// command palette, and responsive Inspector are one interaction system.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_DESIGN_AUDIT_PORT ?? 4577);
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
      if ((await fetch(`${BASE}/api/redesign`)).ok) return;
    } catch {
      // The fixture is still starting.
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(async () => {
  const occupied = await fetch(`${BASE}/api/redesign`).then(
    () => true,
    () => false,
  );
  assert.equal(occupied, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    cargoExecutable,
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  assert.equal(built.status, 0, "could not build the design-audit fixture");
  const fixtureExe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(fixtureExe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "design-audit fixture");
  }
});

async function openSurface(
  viewport = { width: 1280, height: 900 },
  configure = async () => {},
) {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  const page = await context.newPage();
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  await configure(page);
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
  return { context, noise, page };
}

async function closeSurface(surface) {
  await surface.page.unrouteAll({ behavior: "wait" });
  await surface.context.close();
}

function projectEmptyWorkbench(payload, populated) {
  const keyboard = payload.devices.keyboards?.[0];
  for (const collection of [
    payload.devices.keyboards,
    payload.devices.encoders,
    payload.devices.experimental,
  ]) {
    for (const row of collection ?? []) {
      row.aria_current = "false";
      row.staged_revision = "";
    }
  }

  payload.controllers.cards = [];
  payload.controllers.pads = [];
  payload.controllers.counts_line = "0 of 16 slots staged · 0 of 4 Xbox (XInput)";
  payload.operations.draft_empty = !populated;
  payload.operations.draft_dirty = populated;
  payload.operations.draft_label = populated ? "Unsaved draft" : "New draft";
  payload.operations.draft_detail = populated
    ? "One keyboard on the workbench"
    : "Pick an input to begin.";

  if (populated && keyboard) {
    keyboard.aria_current = "true";
    keyboard.staged_revision = "design-audit-keyboard-revision";
    payload.source = keyboard.selector;
    payload.learn_selector = keyboard.selector;
    payload.learn_instance = keyboard.instance_id;
    payload.controllers.source = keyboard.selector;
    payload.controllers.source_revision = keyboard.staged_revision;
    payload.controllers.add_source = keyboard.selector;
    payload.controllers.add_source_revision = keyboard.staged_revision;
    payload.controllers.add_sources = [{
      selector: keyboard.selector,
      revision: keyboard.staged_revision,
      label: keyboard.label || keyboard.name,
      selected: true,
      disabled: false,
    }];
    payload.controllers.add_source_state = "ready";
    payload.controllers.add_source_reason = "";
    payload.board.source = keyboard.selector;
    payload.board.source_revision = keyboard.staged_revision;
  } else {
    payload.source = "";
    payload.learn_selector = "";
    payload.learn_instance = "";
    payload.controllers.source = "";
    payload.controllers.source_revision = "";
    payload.controllers.add_source = "";
    payload.controllers.add_source_revision = "";
    payload.controllers.add_sources = [];
    payload.controllers.add_source_state = "missing";
    payload.controllers.add_source_reason =
      "Add a keyboard or encoder to the canvas before adding a controller.";
    payload.board.source = "";
    payload.board.source_revision = "";
  }
  return payload;
}

async function openControllerInspector(page) {
  const item = page.locator('.forma-canvas-stage > [data-instance-id="ctrl-slot-1"]');
  await item.waitFor({ state: "visible" });
  await item.focus();
  await page.keyboard.press("Control+Enter");
  const inspector = page.locator(".rd-inspector");
  await inspector.waitFor({ state: "visible" });
  if ((await inspector.getAttribute("aria-modal")) === "true") {
    await page.waitForFunction(
      () => document.activeElement?.matches('[data-nx="rd-insp-close"]') === true,
    );
  }
  return { inspector, item };
}

describe("redesign design-audit contracts", { concurrency: false }, () => {
  test("an empty canvas offers both build paths and retires the invitation after Add", async () => {
    let populated = false;
    let devicePosts = 0;
    let controllerPosts = 0;
    const surface = await openSurface({ width: 1280, height: 900 }, async (page) => {
      await page.route(`${BASE}/api/redesign*`, async (route) => {
        const response = await route.fetch();
        const payload = projectEmptyWorkbench(await response.json(), populated);
        await route.fulfill({ response, json: payload });
      });
      await page.route(`${BASE}/redesign/device`, async (route) => {
        devicePosts += 1;
        populated = true;
        await route.fulfill({ status: 204 });
      });
      await page.route(`${BASE}/redesign/controller`, async (route) => {
        controllerPosts += 1;
        await route.fulfill({ status: 204 });
      });
    });
    const { page } = surface;
    try {
      const invitation = page.locator(".rd-canvas-empty");
      await invitation.waitFor({ state: "visible" });
      assert.equal(await invitation.getByRole("heading", { name: "Build your input flow" }).count(), 1);
      assert.equal(
        await page.locator(".forma-canvas-stage > [data-instance-id]").count(),
        0,
        "the invitation is screen-space chrome, never a canvas widget",
      );

      await invitation.getByRole("button", { name: "Add a controller" }).click();
      assert.equal(await page.locator(".rd-ctrlmodal").getAttribute("hidden"), null);
      const unavailablePersona = page.locator(
        '.rd-ctrlmodal [data-rd-form="controller-add"] button',
      ).first();
      assert.equal(await unavailablePersona.getAttribute("aria-disabled"), "true");
      assert.equal(await unavailablePersona.isDisabled(), true);
      await unavailablePersona.evaluate((button) => button.click());
      assert.equal(controllerPosts, 0, "an empty workbench posted an unavailable controller");
      await page.keyboard.press("Escape");
      assert.notEqual(await page.locator(".rd-ctrlmodal").getAttribute("hidden"), null);

      await invitation.getByRole("button", { name: "Add a device" }).click();
      assert.equal(await page.locator(".rd-devmodal").getAttribute("hidden"), null);
      await page.locator('.rd-devmodal button[data-selector="usb:046d:c545:00"]').click();
      await page.waitForFunction(() => document.querySelector(".rd-canvas-empty")?.hidden === true);
      assert.equal(devicePosts, 1, "the empty-state Add device action did not reach staging");
      assert.equal(await invitation.isHidden(), true);
      assert.equal(
        await page.locator('.forma-canvas-stage > [data-selector="usb:046d:c545:00"]').count(),
        1,
        "the added physical input did not replace the invitation",
      );
      assert.deepEqual(surface.noise, [], "the empty-workbench path stays browser-error free");
    } finally {
      await closeSurface(surface);
    }
  });

  test("the phone header stays in bounds with concise, unduplicated action names", async () => {
    const surface = await openSurface({ width: 390, height: 844 });
    const { page } = surface;
    try {
      const pageHeading = page.locator("h1");
      assert.equal(await pageHeading.count(), 1, "the phone surface lost its page heading");
      assert.notEqual(
        await pageHeading.evaluate((heading) => getComputedStyle(heading).display),
        "none",
        "the phone page heading was removed from the accessibility tree",
      );
      assert.equal(await pageHeading.getAttribute("aria-hidden"), null);
      await page.waitForFunction(
        () => (document.querySelector(".rd-live-short")?.textContent?.trim().length ?? 0) > 0,
      );
      const compactLive = await page.locator(".rd-live-short").evaluate((label) => ({
        text: label.textContent?.trim() ?? "",
        width: label.getBoundingClientRect().width,
      }));
      assert.ok(compactLive.text.length > 0, "the phone live-state label is empty");
      assert.ok(
        compactLive.width >= 24,
        `the phone reduced live status to an unreadable dot: ${JSON.stringify(compactLive)}`,
      );
      for (const name of ["Add devices", "Add controllers", "Save", "Play"]) {
        const control = page.getByRole("button", { name, exact: true });
        assert.equal(await control.count(), 1, `${name} is missing or has a duplicated accessible name`);
        assert.equal(await control.isVisible(), true, `${name} is not painted on the phone rail`);
      }
      for (const badName of ["Save Save", "Play Play", "＋ Devices +D", "＋ Controllers +C"]) {
        assert.equal(
          await page.getByRole("button", { name: badName, exact: true }).count(),
          0,
          `generated copy leaked into the accessible name: ${badName}`,
        );
      }

      const geometry = await page.locator(".rd-top").evaluate((header) => {
        const viewport = { height: innerHeight, width: innerWidth };
        const controls = Array.from(
          header.querySelectorAll("button, summary, a[href], input, select"),
        ).filter((element) => {
          const style = getComputedStyle(element);
          const closedDisclosure = element.closest("details:not([open])");
          if (closedDisclosure && element !== closedDisclosure.querySelector(":scope > summary")) {
            return false;
          }
          return !element.closest("[hidden], [inert]") && style.display !== "none" &&
            style.visibility !== "hidden" && element.getClientRects().length > 0;
        }).map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            top: rect.top,
          };
        });
        return {
          controls,
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          viewport,
        };
      });
      for (const control of geometry.controls) {
        assert.ok(control.left >= -0.5, `${control.label} starts outside the phone viewport`);
        assert.ok(
          control.right <= geometry.viewport.width + 0.5,
          `${control.label} ends outside the phone viewport: ${JSON.stringify(control)}`,
        );
        assert.ok(control.top >= -0.5, `${control.label} starts above the phone viewport`);
        assert.ok(
          control.bottom <= geometry.viewport.height + 0.5,
          `${control.label} ends below the phone viewport: ${JSON.stringify(control)}`,
        );
      }
      assert.ok(
        geometry.documentScrollWidth <= geometry.documentClientWidth,
        `the phone shell scrolls sideways: ${JSON.stringify(geometry)}`,
      );
      assert.equal(
        await page.locator(".rd-action-guidance").count(),
        0,
        "blocked-action guidance must not float over the workbench",
      );
      assert.deepEqual(surface.noise, [], "the phone header stays browser-error free");
    } finally {
      await closeSurface(surface);
    }
  });

  test("a blocked lifecycle action remains focusable, explains itself, and never posts", async () => {
    let savePosts = 0;
    const surface = await openSurface({ width: 1280, height: 900 }, async (page) => {
      await page.route(`${BASE}/redesign/save`, async (route) => {
        savePosts += 1;
        await route.fulfill({ status: 204 });
      });
    });
    const { page } = surface;
    try {
      const save = page.getByRole("button", { name: "Save", exact: true });
      assert.equal(await save.getAttribute("aria-disabled"), "true");
      assert.equal(
        await save.evaluate((button) => button.disabled),
        false,
        "product unavailability must not use the native disabled state",
      );
      const reasonId = await save.getAttribute("aria-describedby");
      assert.ok(reasonId, "the blocked action has no programmatic explanation");
      const reason = (await page.locator(`#${reasonId}`).textContent())?.trim() ?? "";
      assert.ok(reason.length > 0, "the blocked action explanation is empty");

      await save.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        ({ reason }) => document.querySelector(".n-live-sr")?.textContent?.includes(reason),
        { reason },
      );
      assert.equal(savePosts, 0, "activation posted an aria-disabled lifecycle action");
      assert.equal(await save.evaluate((button) => document.activeElement === button), true);
      assert.match(await page.locator(".n-live-sr").textContent(), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.deepEqual(surface.noise, [], "the blocked-action path stays browser-error free");
    } finally {
      await closeSurface(surface);
    }
  });

  test("a detached legacy source cannot enable the controller catalog", async () => {
    let controllerPosts = 0;
    const surface = await openSurface({ width: 1280, height: 900 }, async (page) => {
      await page.route(`${BASE}/api/redesign*`, async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        for (const collection of [
          payload.devices.keyboards,
          payload.devices.encoders,
          payload.devices.experimental,
        ]) {
          for (const row of collection ?? []) {
            row.aria_current = "false";
            row.staged_revision = "";
          }
        }
        payload.devices.scan_authoritative = false;
        payload.devices.usb_scan_authoritative = false;
        payload.devices.bluetooth_scan_authoritative = false;
        payload.devices.staging_reachable = true;
        delete payload.controllers.add_sources;
        payload.controllers.add_source = "usb:detached:legacy:00";
        payload.controllers.add_source_revision = "stale-legacy-revision";
        payload.controllers.add_source_state = "ready";
        payload.controllers.add_source_reason = "";
        await route.fulfill({ response, json: payload });
      });
      await page.route(`${BASE}/redesign/controller`, async (route) => {
        controllerPosts += 1;
        await route.fulfill({ status: 204 });
      });
    });
    const { page } = surface;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll(".rd-controller-source option").length === 1,
        null,
        { timeout: 10_000 },
      );
      await page.getByRole("button", { name: "Add controllers", exact: true }).click();
      assert.equal(await page.locator(".rd-controller-source").inputValue(), "");
      const personas = page.locator('.rd-ctrlmodal [data-rd-form="controller-add"] button');
      assert.ok((await personas.count()) > 0, "the controller catalog lost its persona rows");
      assert.equal(
        await personas.evaluateAll((buttons) =>
          buttons.every((button) => button.getAttribute("aria-disabled") === "true")),
        true,
        "a detached legacy scalar armed a controller persona",
      );
      assert.equal(await personas.first().isDisabled(), true);
      await personas.first().evaluate((button) => button.click());
      assert.equal(controllerPosts, 0, "the detached source posted a controller add");
      assert.deepEqual(surface.noise, [], "the mixed-version source guard stays error-free");
    } finally {
      await closeSurface(surface);
    }
  });

  test("Ctrl+K exposes a real combobox pattern while Ctrl+F remains browser-owned", async () => {
    const surface = await openSurface({ width: 1280, height: 900 });
    const { page } = surface;
    try {
      await page.keyboard.press("Control+K");
      const palette = page.locator(".rd-palette");
      await palette.waitFor({ state: "visible" });
      const input = page.getByRole("combobox", { name: "Find a widget or run a command" });
      assert.equal(await input.getAttribute("aria-controls"), "rd-palette-results");
      assert.equal(await input.getAttribute("aria-expanded"), "true");
      assert.equal(await input.getAttribute("aria-autocomplete"), "list");
      assert.equal(
        await page.getByRole("listbox", { name: "Search results" }).count(),
        1,
      );
      const active = await input.getAttribute("aria-activedescendant");
      assert.ok(active, "the active palette option is not exposed through aria-activedescendant");
      assert.equal(await page.locator(`#${active}`).getAttribute("role"), "option");
      assert.equal(await page.locator(`#${active}`).getAttribute("aria-selected"), "true");

      await page.keyboard.press("ArrowDown");
      const moved = await input.getAttribute("aria-activedescendant");
      assert.notEqual(moved, active, "arrow navigation did not move the active descendant");
      assert.equal(await page.locator(`#${moved}`).getAttribute("aria-selected"), "true");
      const resultCount = await page.locator(".rd-palette-row").count();
      for (let index = 2; index < resultCount; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      const lastActive = await input.getAttribute("aria-activedescendant");
      const activeGeometry = await page.locator(`#${lastActive}`).evaluate((option) => {
        const row = option.getBoundingClientRect();
        const list = option.closest(".rd-palette-list")?.getBoundingClientRect();
        return list
          ? { rowTop: row.top, rowBottom: row.bottom, listTop: list.top, listBottom: list.bottom }
          : null;
      });
      assert.ok(activeGeometry, "the active palette option lost its result list");
      assert.ok(
        activeGeometry.rowTop >= activeGeometry.listTop - 0.5 &&
          activeGeometry.rowBottom <= activeGeometry.listBottom + 0.5,
        `the active palette option scrolled out of view: ${JSON.stringify(activeGeometry)}`,
      );
      await page.keyboard.press("Escape");
      assert.equal(await palette.isHidden(), true);

      const findEvent = await page.evaluate(() => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: "f",
        });
        const dispatched = window.dispatchEvent(event);
        return { defaultPrevented: event.defaultPrevented, dispatched };
      });
      assert.deepEqual(findEvent, { defaultPrevented: false, dispatched: true });
      assert.equal(await palette.isHidden(), true, "Ctrl+F opened the product palette");
      assert.deepEqual(surface.noise, [], "the palette semantics stay browser-error free");
    } finally {
      await closeSurface(surface);
    }
  });

  test("the Inspector is modal through 760px, traps focus, and becomes nonmodal at 761px", async () => {
    const surface = await openSurface({ width: 390, height: 844 });
    const { page } = surface;
    try {
      let opened = await openControllerInspector(page);
      const close = opened.inspector.getByRole("button", { name: "Close the inspector" });
      assert.equal(await opened.inspector.getAttribute("role"), "dialog");
      assert.equal(await opened.inspector.getAttribute("aria-modal"), "true");
      assert.equal(await page.locator("main.n-main").getAttribute("inert"), "");
      assert.equal(await close.evaluate((button) => document.activeElement === button), true);

      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await opened.inspector.evaluate((panel) => panel.contains(document.activeElement)),
        true,
        "reverse Tab escaped the modal Inspector",
      );
      assert.equal(
        await opened.inspector.evaluate(() => document.activeElement?.getClientRects().length > 0),
        true,
        "the modal trap focused a control inside a closed disclosure",
      );
      const trapBefore = await opened.inspector.evaluate((panel) => {
        const controls = Array.from(panel.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
            'textarea:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
        )).filter((control) => {
          const style = getComputedStyle(control);
          const closedDisclosure = control.closest("details:not([open])");
          const hiddenByDisclosure = closedDisclosure &&
            control !== closedDisclosure.querySelector(":scope > summary");
          return !control.hidden && !control.closest("[hidden], [inert]") &&
            !hiddenByDisclosure &&
            style.display !== "none" && style.visibility !== "hidden" &&
            control.getClientRects().length > 0;
        });
        controls.forEach((control) => control.removeAttribute("data-rd-test-trap-edge"));
        controls[0]?.setAttribute("data-rd-test-trap-edge", "first");
        controls.at(-1)?.focus();
        return {
          count: controls.length,
          first: controls[0]?.getAttribute("aria-label") || controls[0]?.textContent?.trim(),
          last: controls.at(-1)?.getAttribute("aria-label") || controls.at(-1)?.textContent?.trim(),
          active: document.activeElement?.getAttribute("aria-label") ||
            document.activeElement?.textContent?.trim(),
        };
      });
      await page.keyboard.press("Tab");
      const trapAfter = await opened.inspector.evaluate(() => ({
        atFirst: document.activeElement?.getAttribute("data-rd-test-trap-edge") === "first",
        active: document.activeElement?.getAttribute("aria-label") ||
          document.activeElement?.textContent?.trim(),
        inside: document.querySelector(".rd-inspector")?.contains(document.activeElement),
      }));
      assert.equal(
        trapAfter.atFirst,
        true,
        `forward Tab from the last visible Inspector control did not wrap: ${JSON.stringify({ trapBefore, trapAfter })}`,
      );
      await opened.inspector.evaluate((panel) => {
        panel.querySelectorAll("[data-rd-test-trap-edge]").forEach((control) =>
          control.removeAttribute("data-rd-test-trap-edge")
        );
      });

      // A global child surface must own the one modal layer. Opening the
      // command palette from a phone Inspector suspends the Inspector and
      // releases main rather than stacking two aria-modal focus traps.
      await page.keyboard.press("Control+K");
      const palette = page.locator(".rd-palette");
      await palette.waitFor({ state: "visible" });
      assert.equal(await opened.inspector.isHidden(), true);
      assert.equal(await page.locator("main.n-main").getAttribute("inert"), null);
      assert.equal(
        await page.locator('[role="dialog"][aria-modal="true"]:visible').count(),
        1,
        "the phone exposed more than one modal surface",
      );

      // Rotation can cross the presentation boundary while a child owns the
      // modal layer. Closing it must restore the Inspector as a desktop aside.
      await page.setViewportSize({ width: 761, height: 844 });
      await page.waitForFunction(() => innerWidth === 761);
      await page.keyboard.press("Escape");
      await opened.inspector.waitFor({ state: "visible" });
      assert.equal(await opened.inspector.getAttribute("aria-modal"), null);
      assert.equal(await page.locator("main.n-main").getAttribute("inert"), null);
      assert.equal(
        await close.evaluate((button) => document.activeElement === button),
        true,
        "phone-to-desktop child close did not restore Inspector focus",
      );

      // The inverse transition is equally important: a desktop Inspector may
      // remain visible behind the child, but must suspend before phone layout
      // would promote it into a competing aria-modal dialog.
      await page.keyboard.press("Control+K");
      await palette.waitFor({ state: "visible" });
      assert.equal(await opened.inspector.isVisible(), true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => innerWidth === 390);
      await opened.inspector.waitFor({ state: "hidden" });
      assert.equal(
        await page.locator('[role="dialog"][aria-modal="true"]:visible').count(),
        1,
        "rotation promoted the Inspector into a second mobile modal",
      );
      await page.keyboard.press("Escape");
      await opened.inspector.waitFor({ state: "visible" });
      assert.equal(await opened.inspector.getAttribute("aria-modal"), "true");
      assert.equal(await page.locator("main.n-main").getAttribute("inert"), "");

      await page.keyboard.press("Escape");
      assert.equal(await opened.inspector.isHidden(), true);
      assert.equal(await page.locator("main.n-main").getAttribute("inert"), null);
      assert.equal(
        await opened.item.evaluate((item) => document.activeElement === item),
        true,
        "closing the mobile Inspector did not restore its canvas initiator",
      );

      // Pointer-open follows a different browser focus order from the
      // keyboard shortcut: its default focus step lands after delegated
      // selection. The modal still has to own focus once that click settles.
      await opened.item.click({ position: { x: 12, y: 12 } });
      await opened.inspector.waitFor({ state: "visible" });
      await page.waitForFunction(
        () => document.activeElement?.matches('[data-nx="rd-insp-close"]') === true,
      );
      assert.equal(
        await opened.inspector.evaluate((panel) => panel.contains(document.activeElement)),
        true,
        "pointer-open dropped focus to the document body",
      );
      await page.keyboard.press("Escape");
      await opened.inspector.waitFor({ state: "hidden" });

      await page.setViewportSize({ width: 761, height: 844 });
      await page.waitForFunction(() => innerWidth === 761);
      opened = await openControllerInspector(page);
      assert.equal(await opened.inspector.getAttribute("role"), null);
      assert.equal(await opened.inspector.getAttribute("aria-modal"), null);
      assert.equal(await page.locator("main.n-main").getAttribute("inert"), null);
      await opened.inspector.getByRole("button", { name: "Close the inspector" }).click();
      assert.equal(await opened.inspector.isHidden(), true);
      assert.equal(
        await opened.item.evaluate((item) => document.activeElement === item),
        true,
        "desktop Inspector close did not restore its canvas initiator",
      );
      assert.deepEqual(surface.noise, [], "the responsive Inspector stays browser-error free");
    } finally {
      await closeSurface(surface);
    }
  });
});
