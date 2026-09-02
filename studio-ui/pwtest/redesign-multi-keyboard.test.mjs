// Multi-keyboard canvas contract, exercised through the real /redesign page.
//
// The macro fixture supplies the product shell and controller artwork. This
// test overlays a deterministic two-keyboard/two-controller projection at the
// HTTP boundary so the browser has to prove the product model that hardware
// labels alone cannot: exact physical source identity survives fan-in,
// fan-out, authoring-focus changes, and removal.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { cargoExecutable, stopFixtureProcess } from "./fixture-process.mjs";
import { deviceInstanceId } from "../src/device-instance-id.ts";

const PORT = Number(process.env.KSX_PWTEST_REDESIGN_MULTI_KEYBOARD_PORT ?? 4564);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

const LEFT = "usb:feed:1001:00";
const RIGHT = "usb:feed:1001:01";
const LEFT_INSTANCE = "HID\\VID_FEED&PID_1001&MI_00\\7&KSXLEFT&0&0000";
const RIGHT_INSTANCE = "HID\\VID_FEED&PID_1001&MI_00\\7&KSXRIGHT&0&0000";
const LEFT_SLUG = deviceInstanceId(LEFT);
const RIGHT_SLUG = deviceInstanceId(RIGHT);

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
  assert.equal(built.status, 0, "could not build the multi-keyboard fixture");
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
    await stopFixtureProcess(server, "multi-keyboard fixture");
  }
});

function sourceSpec(selector) {
  return selector === LEFT
    ? {
        selector: LEFT,
        instance: LEFT_INSTANCE,
        alias: "left-keyboard",
        label: "Twin USB Keyboard · left connection",
        connection: "USB FEED:1001 · connection 00",
      }
    : {
        selector: RIGHT,
        instance: RIGHT_INSTANCE,
        alias: "right-keyboard",
        label: "Twin USB Keyboard · right connection",
        connection: "USB FEED:1001 · connection 01",
      };
}

function keyboardRow(prototype, selector, staged, revision) {
  const source = sourceSpec(selector);
  return {
    ...prototype,
    cls: prototype?.cls || "n-dev",
    name: "Twin USB Keyboard",
    meta: `${source.connection} · Ready to use`,
    role: "keyboard",
    selector: source.selector,
    instance_id: source.instance,
    connection_label: source.connection,
    alias: source.alias,
    label: source.label,
    aria_current: staged ? "true" : "false",
    staged_revision: staged ? `device-revision:${revision}:${selector}` : "",
    title: source.label,
    chart_readable: "false",
    profile_state: "none",
    capture_badge: "Ready",
    capture_state: "ready",
    capture_cls: "",
  };
}

function cloneControls(baseControls, mappedFunction, mapped) {
  return baseControls.map((control, index) => ({
    ...control,
    function: control.function || (index === 0 ? mappedFunction : `control-${index}`),
    label: control.label || control.function || `Control ${index + 1}`,
    group: control.group || "face",
    order: Number.isFinite(control.order) ? control.order : index,
    keys: mapped && control.function === mappedFunction ? ["A"] : [],
    toggle: false,
    turbo_hz: null,
  }));
}

function sourceRow(selector, slot, baseControls, mappedFunction, revision) {
  const source = sourceSpec(selector);
  const routed = selector === LEFT || slot === 1;
  const controls = cloneControls(baseControls, mappedFunction, routed);
  return {
    source_id: selector,
    source_alias: source.alias,
    source_label: source.label,
    routed,
    revision: `source-revision:${revision}:${selector}:p${slot}`,
    preset: `multi-${selector === LEFT ? "left" : "right"}-p${slot}`,
    bindings: routed ? 1 : 0,
    fn_keys: routed ? { [mappedFunction]: "A" } : {},
    fn_names: Object.fromEntries(
      controls.map((control) => [control.function, control.label]),
    ),
    controls,
    macros: [],
    mapping_available: true,
    mapping_reason: "",
    macro_available: true,
    macro_reason: "",
  };
}

function selectedSourceFor(url, staged) {
  const requested = url.searchParams.get("source") ?? "";
  if (staged.has(requested)) return requested;
  return [LEFT, RIGHT].find((selector) => staged.has(selector)) ?? "";
}

/** Mutate a real fixture payload into the exact many-to-many graph under
 * test. Every staged source is represented below every controller, including
 * RIGHT's intentionally unrouted synthetic row under P2. */
function projectManyToMany(payload, requestUrl, state) {
  const prototype = payload.devices.keyboards?.[0] ?? {};
  payload.devices.keyboards = [
    keyboardRow(prototype, LEFT, state.staged.has(LEFT), state.revision),
    keyboardRow(prototype, RIGHT, state.staged.has(RIGHT), state.revision),
  ];
  payload.devices.keyboards_head = "KEYBOARDS · 2";
  payload.devices.keyboards_fold_cls = "n-devfold";
  payload.devices.scan_authoritative = true;
  payload.devices.staging_reachable = true;
  payload.devices.staging_line = "Two exact source fixture";
  for (const tier of ["encoders", "experimental"]) {
    for (const row of payload.devices[tier] ?? []) row.aria_current = "false";
  }

  const baseCard = payload.controllers.cards?.[0];
  const basePad = payload.controllers.pads?.[0];
  assert.ok(baseCard, "macro fixture must serve one controller card");
  assert.ok(basePad, "macro fixture must serve one controller pad");
  const baseControls = (basePad.controls?.length ? basePad.controls : [{
    function: "a",
    label: "A",
    group: "face",
    order: 0,
    keys: [],
    toggle: false,
    turbo_hz: null,
  }]).map((control) => ({ ...control, keys: [] }));
  const leftMappedFunction =
    baseControls.find((control) => control.function.toLowerCase() === "a")?.function ??
    baseControls[0].function;
  const rightMappedFunction =
    baseControls.find((control) => control.function.toLowerCase() === "b")?.function ??
    baseControls.find((control) => control.function !== leftMappedFunction)?.function ??
    leftMappedFunction;
  state.mappedFunctions = {
    [LEFT]: leftMappedFunction,
    [RIGHT]: rightMappedFunction,
  };

  payload.controllers.cards = [1, 2].map((slot) => ({
    ...baseCard,
    number: String(slot),
    identity_key: `slot:${slot}:${baseCard.persona}`,
    display_name: `Player ${slot} · ${baseCard.persona_label}`,
    preset: `multi-controller-p${slot}`,
  }));
  payload.controllers.pads = [1, 2].map((slot) => {
    const sources = [LEFT, RIGHT]
      .filter((selector) => state.staged.has(selector))
      .map((selector) =>
        sourceRow(
          selector,
          slot,
          baseControls,
          state.mappedFunctions[selector],
          state.revision,
        )
      );
    // Mirror the production compatibility seam: pad-level fields always
    // project the first source. The current authoring source is canonical only
    // in `sources`, so a RIGHT-source card test cannot pass by accident from a
    // fixture that helpfully rewrites this legacy projection.
    const compatibility = sources[0];
    return {
      ...basePad,
      slot,
      preset: `multi-controller-p${slot}`,
      title: `Player ${slot}`,
      target_revision: `controller-revision:${state.revision}:p${slot}`,
      fn_keys: compatibility?.fn_keys ?? {},
      fn_names: compatibility?.fn_names ?? basePad.fn_names,
      controls: compatibility?.controls ?? cloneControls(baseControls, leftMappedFunction, false),
      macros: [],
      mapping_available: true,
      mapping_reason: "",
      macro_available: true,
      macro_reason: "",
      sources,
    };
  });
  for (const [index, card] of payload.controllers.cards.entries()) {
    // Production's card-level preset is the first-route compatibility view.
    // It deliberately changes when LEFT is removed; card identity must not.
    card.preset = payload.controllers.pads[index].sources[0]?.preset ?? card.preset;
  }
  payload.controllers.counts_line = "2 controllers · 2 exact keyboards";

  const selectedSlot = Number(requestUrl.searchParams.get("slot") ?? "1") === 2 ? 2 : 1;
  const selectedSource = selectedSourceFor(requestUrl, state.staged);
  const selectedRow = payload.controllers.pads[selectedSlot - 1].sources.find(
    (source) => source.source_id === selectedSource,
  );
  payload.source = selectedSource;
  payload.controllers.source = selectedSource;
  payload.controllers.source_revision = selectedRow?.revision ?? "";
  payload.controllers.source_preset = selectedRow?.preset ?? "";
  payload.controllers.panel = {
    ...payload.controllers.panel,
    slot_val: String(selectedSlot),
    source: selectedSource,
    source_revision: selectedRow?.revision ?? "",
    source_preset: selectedRow?.preset ?? "",
  };
  payload.controllers.keys = {
    ...payload.controllers.keys,
    source: selectedSource,
    source_revision: selectedRow?.revision ?? "",
    source_preset: selectedRow?.preset ?? "",
  };
  payload.board = {
    ...payload.board,
    source: selectedSource,
    source_revision: selectedRow?.revision ?? "",
    source_preset: selectedRow?.preset ?? "",
  };
  payload.learn_selector = selectedSource;
  payload.learn_instance = selectedSource ? sourceSpec(selectedSource).instance : "";
  payload.operations.draft_revision = `draft-revision:${state.revision}`;
  return payload;
}

async function closeScenario(scenario) {
  if (!scenario) return;
  await scenario.page.unrouteAll({ behavior: "wait" });
  await scenario.context.close();
}

async function openScenario() {
  const context = await browser.newContext({
    viewport: { width: 2600, height: 1400 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const noise = [];
  const state = {
    staged: new Set(),
    revision: 1,
    addBodies: [],
    removeBodies: [],
  };
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });

  await page.route(`${BASE}/api/redesign*`, async (route) => {
    const response = await route.fetch();
    const payload = projectManyToMany(
      await response.json(),
      new URL(route.request().url()),
      state,
    );
    await route.fulfill({ response, json: payload });
  });
  await page.route(`${BASE}/redesign/device`, async (route) => {
    const body = new URLSearchParams(route.request().postData() ?? "");
    const selector = body.get("selector") ?? "";
    assert.ok(selector === LEFT || selector === RIGHT, `unexpected source add ${selector}`);
    state.addBodies.push(body);
    state.staged.add(selector);
    state.revision += 1;
    await route.fulfill({ status: 204 });
  });
  await page.route(`${BASE}/redesign/device/remove`, async (route) => {
    const body = new URLSearchParams(route.request().postData() ?? "");
    const selector = body.get("selector") ?? "";
    assert.ok(selector === LEFT || selector === RIGHT, `unexpected source removal ${selector}`);
    state.removeBodies.push(body);
    if (body.get("confirm_remove") !== "yes") {
      await route.fulfill({ status: 409, body: "confirmation required" });
      return;
    }
    state.staged.delete(selector);
    state.revision += 1;
    await route.fulfill({ status: 204 });
  });

  await page.goto(`${BASE}/redesign?slot=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
    null,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    (right) =>
      Boolean(document.querySelector(`.rd-devmodal button[data-selector="${right}"]`)) &&
      document.querySelectorAll('.forma-canvas-stage > [data-instance-id^="ctrl-slot-"]')
        .length === 2 &&
      Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
    RIGHT,
    { timeout: 20_000 },
  );
  return { context, page, state, noise };
}

async function addBothKeyboards(page, state) {
  await page.locator('[data-nx="rd-devs-open"]').click();
  for (const selector of [LEFT, RIGHT]) {
    await page.locator(`.rd-devmodal button[data-selector="${selector}"]`).click();
    try {
      await page.waitForFunction(
        (id) =>
          document.querySelector(`.forma-canvas-stage > [data-instance-id="${id}"]`)
            ?.dataset.mappingAvailable === "true",
        deviceInstanceId(selector),
        { timeout: 12_000 },
      );
    } catch (error) {
      const visible = await page.locator(".rd-keyboard-device-node").evaluateAll((nodes) =>
        nodes.map((node) => ({
          selector: node.getAttribute("data-selector"),
          staged: node.getAttribute("data-staged"),
          mapping: node.getAttribute("data-mapping-available"),
          instance: node.getAttribute("data-instance-id"),
        }))
      );
      throw new Error(
        `source ${selector} did not become editable; staged=${JSON.stringify([...state.staged])}; ` +
          `adds=${state.addBodies.length}; canvas=${JSON.stringify(visible)}`,
        { cause: error },
      );
    }
  }
  await page.keyboard.press("Escape");
}

function keyboardNode(page, slug) {
  return page.locator(`.forma-canvas-stage > [data-instance-id="${slug}"]`);
}

async function chooseAuthoringSource(page, selector) {
  await page.locator('.navigator-item[data-instance-id="ctrl-slot-1"]')
    .evaluate((button) => button.click());
  const button = page.locator(
    `.rd-inspector [data-nx="rd-source-authoring"][data-selector="${selector}"]`,
  );
  await button.waitFor({ state: "visible" });
  await button.click();
  await page.waitForFunction(
    (source) => new URLSearchParams(location.search).get("source") === source,
    selector,
  );
  await page.waitForFunction(
    (id) => document.querySelector(
      `.forma-canvas-stage > [data-instance-id="${id}"]`,
    )?.hasAttribute("data-authoring-source") === true,
    deviceInstanceId(selector),
    { timeout: 12_000 },
  );
}

async function controllerCalloutTexts(page, slot, functionName) {
  return page.locator(
    `.forma-canvas-stage > [data-instance-id="ctrl-slot-${slot}"] text.n-fnkey`,
  ).evaluateAll((nodes, expected) => nodes
    .filter((node) => (node.getAttribute("data-fn") ?? "")
      .split(/\s+/)
      .some((name) => name.toLowerCase() === expected.toLowerCase()))
    .map((node) => node.textContent?.trim() ?? ""), functionName);
}

async function controllerPresentation(page, slot) {
  const id = `ctrl-slot-${slot}`;
  const item = page.locator(`.forma-canvas-stage > [data-instance-id="${id}"]`);
  const card = item.locator(".rd-ctrlcard");
  const marker = page.locator(`.navigator-item[data-instance-id="${id}"]`);
  return {
    identity: await card.getAttribute("data-controller-identity"),
    finishStoreKey: await card.getAttribute("data-finish-store-key"),
    name: (await card.locator(".rd-ctrlcard-name").textContent())?.trim(),
    widgetName: await item.getAttribute("data-widget-name"),
    ariaLabel: await item.getAttribute("aria-label"),
    moveLabel: await item.locator(".widget-drag-handle").getAttribute("aria-label"),
    navigatorTitle: await marker.getAttribute("title"),
    navigatorLabel: await marker.getAttribute("aria-label"),
  };
}

describe("redesign multi-keyboard canvas", { concurrency: false }, () => {
  test("the keyboard canvas is empty until Add and each exact source owns one full board", async () => {
    const scenario = await openScenario();
    const { page, state, noise } = scenario;
    try {
      assert.equal(
        await page.locator(".rd-keyboard-device-node").count(),
        0,
        "no physical or synthetic keyboard is implicit",
      );
      assert.equal(
        await page.locator('.forma-canvas-stage > [data-instance-id="keyboard"]').evaluateAll(
          (items) => items.filter((item) =>
            !item.hidden && getComputedStyle(item).display !== "none" &&
            item.getClientRects().length > 0
          ).length,
        ),
        0,
        "the compatibility blueprint is never a visible canvas board",
      );

      await addBothKeyboards(page, state);

      assert.deepEqual([...state.staged].sort(), [LEFT, RIGHT].sort());
      assert.equal(state.addBodies.length, 2, "each picker Add stages that exact source");
      assert.equal(await page.locator(".rd-keyboard-device-node").count(), 2);
      assert.equal(await page.locator("[data-rd-keyboard-surface]").count(), 2);
      assert.equal(
        await page.locator('.forma-canvas-stage > [data-instance-id="keyboard"]').evaluateAll(
          (items) => items.filter((item) =>
            !item.hidden && getComputedStyle(item).display !== "none" &&
            item.getClientRects().length > 0
          ).length,
        ),
        0,
      );
      for (const [selector, slug] of [[LEFT, LEFT_SLUG], [RIGHT, RIGHT_SLUG]]) {
        const board = keyboardNode(page, slug);
        const expectedLabel = `Twin USB Keyboard · ${sourceSpec(selector).connection}`;
        assert.equal(await board.count(), 1, `${selector} has one canvas object`);
        assert.equal(await board.getAttribute("data-source-id"), selector);
        assert.equal(await board.getAttribute("aria-label"), expectedLabel);
        assert.equal(
          await board.locator("[data-rd-keyboard-surface]").getAttribute("aria-label"),
          `${expectedLabel} keyboard`,
        );
        assert.equal(await board.locator(".n-kbhead > .n-kick").textContent(), expectedLabel);
        assert.equal(
          await board.locator(".widget-drag-handle").getAttribute("aria-label"),
          `Move ${expectedLabel}`,
        );
        assert.equal(
          await page.locator(`.navigator-item[data-instance-id="${slug}"]`).getAttribute("aria-label"),
          `Focus ${expectedLabel}`,
        );
        assert.equal(await board.locator("[data-rd-keyboard-surface]").count(), 1);
        assert.ok(
          await board.locator('.n-kb button.n-key[data-key="A"]').count() === 1 &&
          await board.locator(".n-kb button.n-key[data-key]").count() > 80,
          `${selector} owns one complete interactive keyboard drawing`,
        );
        assert.equal(
          await page.locator(`.forma-canvas-stage > [data-selector="${selector}"]`).count(),
          1,
          "identity is part of the board, never a second summary widget",
        );
      }
      assert.deepEqual(noise, [], "the two-board add path stays browser-error free");
    } finally {
      await closeScenario(scenario);
    }
  });

  test("fan-in and fan-out keep same-key cords source-qualified while focus stays non-exclusive", async () => {
    const scenario = await openScenario();
    const { page, noise } = scenario;
    try {
      await addBothKeyboards(page, scenario.state);

      const served = await page.evaluate(async () =>
        (await fetch("/api/redesign?slot=1")).json()
      );
      assert.deepEqual(
        served.devices.keyboards.filter((row) => row.aria_current === "true")
          .map((row) => row.selector).sort(),
        [LEFT, RIGHT].sort(),
        "both physical rows are simultaneously staged",
      );
      const p1 = served.controllers.pads.find((pad) => pad.slot === 1);
      const p2 = served.controllers.pads.find((pad) => pad.slot === 2);
      assert.deepEqual(
        p1.sources.filter((source) => source.routed).map((source) => source.source_id).sort(),
        [LEFT, RIGHT].sort(),
        "two keyboards fan into player one",
      );
      assert.equal(
        p2.sources.find((source) => source.source_id === LEFT)?.routed,
        true,
        "the left keyboard also fans out to player two",
      );
      assert.equal(
        p2.sources.find((source) => source.source_id === RIGHT)?.routed,
        false,
        "the unused peer still has a first-bind authoring row",
      );

      const visibleLegendSlots = async (slug) =>
        keyboardNode(page, slug).locator(".n-legend [data-slot]").evaluateAll(
          (chips) => chips.filter((chip) => !chip.hidden).map((chip) => chip.dataset.slot),
        );
      assert.deepEqual(
        await visibleLegendSlots(LEFT_SLUG),
        ["1", "2"],
        "LEFT's board legend includes both of LEFT's routes",
      );
      assert.deepEqual(
        await visibleLegendSlots(RIGHT_SLUG),
        ["1"],
        "RIGHT's unrouted P2 authoring row is not presented as an existing route",
      );

      const sameKeyOwners = await page.locator(
        '.rd-keyboard-device-node .n-kb button.n-key[data-key="A"]',
      ).evaluateAll((keys) => keys.map((key) => ({
        key: key.getAttribute("data-key"),
        source: key.closest(".rd-keyboard-device-node")?.getAttribute("data-source-id"),
      })));
      assert.deepEqual(
        sameKeyOwners.sort((left, right) => left.source.localeCompare(right.source)),
        [
          { key: "A", source: LEFT },
          { key: "A", source: RIGHT },
        ],
        "the same symbol remains two physical endpoints",
      );

      const pathMode = page.locator('select[data-nx="rd-mapping-paths"]');
      await pathMode.selectOption("all");
      await page.waitForFunction(
        () => {
          const routes = Array.from(document.querySelectorAll(
            '#n-mapping-paths > [data-flow-kind="binding"]:not(.is-unresolved)',
          ));
          return routes.length === 3 && routes.every((route) =>
            (route.querySelector(".n-flow-core")?.getAttribute("d") ?? "").length > 0
          );
        },
        null,
        { timeout: 12_000 },
      );
      const cords = await page.locator(
        '#n-mapping-paths > [data-flow-kind="binding"]',
      ).evaluateAll((groups) => groups.map((group) => ({
        source: group.getAttribute("data-flow-source-id"),
        slot: group.getAttribute("data-flow-slot"),
        key: group.getAttribute("data-flow-key"),
        path: group.querySelector(".n-flow-core")?.getAttribute("d") ?? "",
        unresolved: group.classList.contains("is-unresolved"),
      })));
      assert.deepEqual(
        cords.map(({ source, slot, key }) => ({ source, slot, key }))
          .sort((left, right) => `${left.slot}:${left.source}`.localeCompare(`${right.slot}:${right.source}`)),
        [
          { source: LEFT, slot: "1", key: "A" },
          { source: RIGHT, slot: "1", key: "A" },
          { source: LEFT, slot: "2", key: "A" },
        ].sort((left, right) => `${left.slot}:${left.source}`.localeCompare(`${right.slot}:${right.source}`)),
      );
      assert.equal(cords.every((cord) => !cord.unresolved && Boolean(cord.path)), true);
      assert.notEqual(
        cords.find((cord) => cord.source === LEFT && cord.slot === "1")?.path,
        cords.find((cord) => cord.source === RIGHT && cord.slot === "1")?.path,
        "same-key fan-in starts at two different board anchors",
      );

      await chooseAuthoringSource(page, LEFT);
      const leftPresentation = await controllerPresentation(page, 1);
      const leftFunction = scenario.state.mappedFunctions[LEFT];
      const rightFunction = scenario.state.mappedFunctions[RIGHT];
      assert.notEqual(
        leftFunction,
        rightFunction,
        "the two exact sources deliberately map the same physical key to different controls",
      );
      assert.ok(
        (await controllerCalloutTexts(page, 1, leftFunction)).includes("A"),
        "the card paints LEFT's nested same-key route",
      );
      assert.equal(
        (await controllerCalloutTexts(page, 1, rightFunction)).some(Boolean),
        false,
        "the card does not cross-paint RIGHT while LEFT is authoring",
      );
      assert.deepEqual(
        await page.locator('.rd-inspector [data-nx="rd-source-authoring"]')
          .allTextContents(),
        [
          "Twin USB Keyboard · USB FEED:1001 · connection 00",
          "Twin USB Keyboard · USB FEED:1001 · connection 01",
        ],
        "same-model source tabs expose their exact connection identities",
      );
      await chooseAuthoringSource(page, RIGHT);
      assert.deepEqual(
        await controllerPresentation(page, 1),
        leftPresentation,
        "authoring A↔B changes route inspection, never card/navigator/finish identity",
      );
      assert.ok(
        (await controllerCalloutTexts(page, 1, rightFunction)).includes("A"),
        "switching authoring focus immediately repaints from RIGHT's nested route",
      );
      assert.equal(
        (await controllerCalloutTexts(page, 1, leftFunction)).some(Boolean),
        false,
        "the compatibility first-source callout is not left behind on RIGHT",
      );
      const rightServed = await page.evaluate(async () =>
        (await fetch("/api/redesign?slot=1&source=usb%3Afeed%3A1001%3A01")).json()
      );
      const rightPad = rightServed.controllers.pads.find((pad) => pad.slot === 1);
      assert.deepEqual(
        rightPad.fn_keys,
        rightPad.sources[0].fn_keys,
        "the regression retains the production first-source compatibility projection",
      );
      assert.notDeepEqual(
        rightPad.fn_keys,
        rightPad.sources.find((source) => source.source_id === RIGHT).fn_keys,
        "only the canonical nested RIGHT row contains RIGHT's controller target",
      );
      assert.equal(await page.locator('[data-mapping-source="true"]').count(), 0);
      assert.equal(await keyboardNode(page, RIGHT_SLUG).getAttribute("data-authoring-source"), "");
      for (const slug of [LEFT_SLUG, RIGHT_SLUG]) {
        const board = keyboardNode(page, slug);
        assert.equal(await board.getAttribute("data-mapping-available"), "true");
        assert.equal(await board.locator("[data-rd-keyboard-surface]").count(), 1);
        assert.equal(await board.locator('.n-kb button.n-key[data-key="A"]').isDisabled(), false);
      }
      assert.equal(
        await page.locator('#n-mapping-paths > [data-flow-kind="binding"]').count(),
        3,
        "authoring focus changes no peer route",
      );
      assert.deepEqual(noise, [], "source focus and cord layout stay browser-error free");
    } finally {
      await closeScenario(scenario);
    }
  });

  test("mapped-source removal requires confirmation and persists without disturbing its peer", async () => {
    const scenario = await openScenario();
    const { page, state, noise } = scenario;
    try {
      await addBothKeyboards(page, state);
      const beforeRemoval = await controllerPresentation(page, 1);
      assert.deepEqual(beforeRemoval, {
        identity: "slot:1:xbox360",
        finishStoreKey: "c:slot:1:xbox360",
        name: "Player 1 · Xbox 360",
        widgetName: "Player 1 · Xbox 360",
        ariaLabel: "Player 1 · Xbox 360",
        moveLabel: "Move Player 1 · Xbox 360",
        navigatorTitle: "Player 1 · Xbox 360",
        navigatorLabel: "Focus Player 1 · Xbox 360",
      });
      await page.locator('[data-nx="rd-devs-open"]').click();
      const leftRow = page.locator(`.rd-devmodal button[data-selector="${LEFT}"]`);

      let dismissedMessage = "";
      page.once("dialog", async (dialog) => {
        dismissedMessage = dialog.message();
        await dialog.dismiss();
      });
      await leftRow.click();
      assert.match(dismissedMessage, /routes to P1, P2 will be removed/i);
      assert.equal(state.removeBodies.length, 0, "Cancel performs no backend mutation");
      assert.equal(await keyboardNode(page, LEFT_SLUG).count(), 1);

      let acceptedMessage = "";
      page.once("dialog", async (dialog) => {
        acceptedMessage = dialog.message();
        await dialog.accept();
      });
      await leftRow.click();
      await page.waitForFunction(
        (slug) => !document.querySelector(
          `.forma-canvas-stage > [data-instance-id="${slug}"]`,
        ),
        LEFT_SLUG,
        { timeout: 12_000 },
      );
      assert.match(acceptedMessage, /Controllers and other keyboards stay unchanged/i);
      assert.equal(state.removeBodies.length, 1);
      assert.equal(state.removeBodies[0].get("selector"), LEFT);
      assert.equal(state.removeBodies[0].get("confirm_remove"), "yes");
      assert.equal(state.removeBodies[0].get("expected_revision"), "draft-revision:3");
      assert.equal(
        state.removeBodies[0].get("expected_source_revision"),
        `device-revision:3:${LEFT}`,
      );
      assert.deepEqual([...state.staged], [RIGHT]);
      assert.equal(await keyboardNode(page, RIGHT_SLUG).count(), 1);
      assert.deepEqual(
        await controllerPresentation(page, 1),
        beforeRemoval,
        "removing the primary route cannot rename or repaint the virtual controller seat",
      );
      const afterRemoval = await page.evaluate(async () =>
        (await fetch("/api/redesign?slot=1")).json()
      );
      assert.equal(
        afterRemoval.controllers.cards[0].preset,
        "multi-right-p1",
        "the fixture proves primary compatibility metadata really changed",
      );
      assert.equal(
        await page.evaluate((selector) => {
          const saved = JSON.parse(localStorage.getItem("ksx-redesign-canvas") ?? "{}");
          return saved.bench?.includes(selector) ?? false;
        }, LEFT),
        false,
        "the removed exact source leaves durable canvas membership",
      );

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        (right) => document.querySelector(
          `.forma-canvas-stage > [data-instance-id="${right}"]`,
        )?.dataset.mappingAvailable === "true",
        RIGHT_SLUG,
        { timeout: 20_000 },
      );
      assert.equal(await keyboardNode(page, LEFT_SLUG).count(), 0);
      assert.equal(await keyboardNode(page, RIGHT_SLUG).count(), 1);
      assert.deepEqual(
        await controllerPresentation(page, 1),
        beforeRemoval,
        "seat identity and finish key survive a reload after primary-route removal",
      );
      assert.deepEqual(noise, [], "confirmed exact-source removal stays browser-error free");
    } finally {
      await closeScenario(scenario);
    }
  });
});
