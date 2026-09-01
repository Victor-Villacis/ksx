// Exact-source authority for redesign keyboard mapping.
//
// The mapper must never collapse two physical keyboards merely because they
// emit the same key. These tests pin the pure wire/revision rules and the one
// browser-only detail: interaction marks stay on the board that was clicked.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";
import {
  mapperBindPayload,
  mapperPinTarget,
  mapperSourceMatchesTarget,
  mapperTargetAdvanced,
} from "../src/redesign-mapper.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mapperEntry = path.join(repoRoot, "studio-ui", "src", "redesign-mapper.ts");

const left = {
  selector: "usb:1111:0001:00",
  instance: "HID\\VID_1111&PID_0001\\LEFT",
};
const right = {
  selector: "usb:2222:0002:00",
  instance: "HID\\VID_2222&PID_0002\\RIGHT",
};
const serialUpper = {
  selector: "usb:3333:0003:00:sn=BoardA",
  instance: "HID\\VID_3333&PID_0003\\UPPER",
};
const serialLower = {
  selector: "usb:3333:0003:00:sn=boarda",
  instance: "HID\\VID_3333&PID_0003\\LOWER",
};

function source(sourceId, revision, routed = true) {
  return {
    source_id: sourceId,
    revision,
    preset: `${sourceId}-map`,
    routed,
    controls: [{ function: "a", label: "A", keys: ["K"] }],
  };
}

function pads(leftRevision = "left-r1", rightRevision = "right-r1") {
  return [{
    slot: 1,
    preset: "compatibility-only",
    target_revision: "slot-revision-must-not-authorize-source-writes",
    sources: [
      source(left.selector, leftRevision),
      { ...source(right.selector, rightRevision), source_id: undefined, sourceId: right.selector },
    ],
  }];
}

function target(overrides = {}) {
  return {
    fn: "a",
    label: "A",
    slot: "1",
    mode: "replace",
    ...overrides,
  };
}

describe("redesign mapper exact-source protocol", () => {
  test("two sources emitting the same key pin and write independently", () => {
    const leftTarget = mapperPinTarget(pads(), target({
      expectedDevice: left.selector,
      expectedInstance: left.instance,
      followsAuthoringFocus: false,
    }), right);
    const rightTarget = mapperPinTarget(pads(), target({
      expectedDevice: right.selector,
      expectedInstance: right.instance,
      followsAuthoringFocus: false,
    }), left);

    assert.ok(leftTarget);
    assert.ok(rightTarget);
    assert.equal(leftTarget.expectedDevice, left.selector);
    assert.equal(leftTarget.expectedTargetRevision, "left-r1");
    assert.equal(rightTarget.expectedDevice, right.selector);
    assert.equal(rightTarget.expectedTargetRevision, "right-r1");

    const leftPayload = mapperBindPayload(leftTarget, "K", false);
    const rightPayload = mapperBindPayload(rightTarget, "K", false);
    assert.deepEqual(leftPayload, {
      slot: 1,
      expected_device: left.selector,
      expected_target_revision: "left-r1",
      function: "a",
      key: "K",
      mode: "replace",
      force: false,
    });
    assert.deepEqual(rightPayload, {
      ...leftPayload,
      expected_device: right.selector,
      expected_target_revision: "right-r1",
    });
    assert.notDeepEqual(leftPayload, rightPayload);
  });

  test("control-first pin follows authoring focus but a clicked board pin does not", () => {
    const controlFirst = mapperPinTarget(pads(), target(), left);
    assert.ok(controlFirst);
    assert.equal(controlFirst.expectedDevice, left.selector);
    assert.equal(controlFirst.expectedInstance, left.instance);
    assert.equal(controlFirst.followsAuthoringFocus, true);
    assert.equal(
      mapperPinTarget(pads(), controlFirst, right),
      null,
      "a control-first gesture cannot silently follow a later source switch",
    );

    const clickedRight = mapperPinTarget(pads(), target({
      expectedDevice: right.selector,
      expectedInstance: right.instance,
      followsAuthoringFocus: false,
    }), left);
    assert.ok(clickedRight);
    assert.equal(clickedRight.expectedDevice, right.selector);
    assert.equal(clickedRight.expectedInstance, right.instance);
    assert.equal(clickedRight.followsAuthoringFocus, false);
  });

  test("only the exact source revision can confirm a successful bind", () => {
    const pinned = mapperPinTarget(pads(), target(), left);
    assert.ok(pinned);

    const unrelatedAdvance = pads("left-r1", "right-r2");
    unrelatedAdvance[0].target_revision = "slot-r99";
    assert.equal(mapperTargetAdvanced(unrelatedAdvance, pinned), false);
    assert.equal(mapperTargetAdvanced(pads("left-r2", "right-r1"), pinned), true);

    const routeRemoved = pads();
    routeRemoved[0].sources = routeRemoved[0].sources.filter(
      (candidate) => (candidate.source_id ?? candidate.sourceId) !== left.selector,
    );
    assert.equal(mapperTargetAdvanced(routeRemoved, pinned), false);
    assert.equal(mapperTargetAdvanced([], pinned), false);

    const routeUnrouted = pads();
    routeUnrouted[0].sources[0].routed = false;
    assert.equal(mapperTargetAdvanced(routeUnrouted, pinned), false);
    assert.equal(
      mapperTargetAdvanced(routeUnrouted, { ...pinned, mode: "remove" }),
      true,
    );
  });

  test("a routed:false synthetic row authorizes the first exact bind", () => {
    const syntheticPads = [{
      slot: 1,
      preset: "compatibility-only",
      sources: [source(left.selector, "synthetic-r1", false)],
    }];
    const pinned = mapperPinTarget(syntheticPads, target(), left);
    assert.ok(pinned);
    assert.equal(pinned.expectedDevice, left.selector);
    assert.equal(pinned.expectedTargetRevision, "synthetic-r1");
    assert.equal(pinned.expectedSourceRouted, false);
    assert.equal(mapperTargetAdvanced(syntheticPads, pinned), false);

    const firstBind = structuredClone(syntheticPads);
    firstBind[0].sources[0].routed = true;
    firstBind[0].sources[0].revision = "left-routed-r2";
    assert.equal(mapperTargetAdvanced(firstBind, pinned), true);
  });

  test("stale source, routed state, and slot fail closed", () => {
    assert.equal(mapperPinTarget(
      pads("left-r2"),
      target({
        expectedDevice: left.selector,
        expectedTargetRevision: "left-r1",
        bindingAuthorityPinned: true,
      }),
      left,
    ), null);

    const unrouted = pads();
    unrouted[0].sources[0].routed = false;
    assert.equal(mapperPinTarget(
      unrouted,
      target({
        expectedDevice: left.selector,
        expectedTargetRevision: "left-r1",
        expectedSourceRouted: true,
        bindingAuthorityPinned: true,
      }),
      left,
    ), null);
    assert.equal(mapperPinTarget([], target(), left), null);
    assert.equal(mapperPinTarget(pads(), target({ slot: "2" }), left), null);

    const topLevelOnly = [{
      slot: 1,
      preset: "old-preset",
      target_revision: "slot-r1",
    }];
    assert.equal(
      mapperPinTarget(topLevelOnly, target(), left),
      null,
      "a slot-level revision cannot authorize an exact-source write",
    );
    const pinned = mapperPinTarget(pads(), target(), left);
    assert.ok(pinned);
    assert.equal(
      mapperTargetAdvanced([{ ...topLevelOnly[0], target_revision: "slot-r2" }], pinned),
      false,
      "a slot-level revision cannot confirm an exact-source write",
    );
  });

  test("a learn hit from another physical keyboard is rejected", () => {
    const pinned = mapperPinTarget(pads(), target(), left);
    assert.ok(pinned);
    assert.equal(mapperSourceMatchesTarget(pinned, left), true);
    assert.equal(mapperSourceMatchesTarget(pinned, {
      selector: left.selector.toUpperCase(),
      instance: "",
    }), true);
    assert.equal(mapperSourceMatchesTarget(pinned, {
      selector: right.selector,
      instance: left.instance.toLowerCase(),
    }), true, "the verified Windows instance independently corroborates the source");
    assert.equal(mapperSourceMatchesTarget(pinned, right), false);
    assert.equal(mapperSourceMatchesTarget(pinned, { selector: "", instance: "" }), false);
  });

  test("case-distinct firmware serials never share source authority", () => {
    const twinPads = [{
      slot: 1,
      preset: "compatibility-only",
      sources: [
        source(serialUpper.selector, "upper-r1"),
        source(serialLower.selector, "lower-r1"),
      ],
    }];
    const lowerTarget = mapperPinTarget(twinPads, target({
      expectedDevice: serialLower.selector,
      expectedInstance: serialLower.instance,
      followsAuthoringFocus: false,
    }), serialUpper);

    assert.ok(lowerTarget);
    assert.equal(lowerTarget.expectedDevice, serialLower.selector);
    assert.equal(lowerTarget.expectedTargetRevision, "lower-r1");
    assert.equal(mapperSourceMatchesTarget(lowerTarget, serialUpper), false);
    assert.equal(mapperSourceMatchesTarget(lowerTarget, serialLower), true);
  });
});

let browser;
let mapperBundle;

before(async () => {
  const built = await build({
    entryPoints: [mapperEntry],
    bundle: true,
    format: "iife",
    globalName: "KSXMapper",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  mapperBundle = built.outputFiles[0].text;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

describe("redesign mapper exact board marks", { concurrency: false }, () => {
  test("control-first listen cue belongs only to the exact source board", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <main id="root">
          <div class="rd-learnbar none">
            <span class="rd-learn-line"></span><span class="rd-learn-sub"></span>
            <button data-nx="rd-learn-skip"></button>
            <label class="rd-chain"><input class="rd-chain-box" type="checkbox"></label>
          </div>
          <section id="left" data-source-id="${left.selector}">
            <div class="rd-keycue none"><span class="rd-keycue-text"></span></div>
          </section>
          <section id="right" data-source-id="${right.selector}">
            <div class="rd-keycue none"><span class="rd-keycue-text"></span></div>
          </section>
        </main>
      `);
      await page.addScriptTag({ content: mapperBundle });
      await page.evaluate(async ({ left, right }) => {
        window.fetch = async (input) => {
          const url = String(input);
          const listening = {
            ok: true,
            state: "listening",
            generation: 9,
            remaining_ms: 10_000,
          };
          return new Response(JSON.stringify(
            url.endsWith("/api/learn/cancel") ? { ...listening, state: "cancelled" } : listening,
          ), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        };
        KSXMapper.mapperWire({
          root: () => document.querySelector("#root"),
          flash: () => {},
          refresh: async () => true,
          announce: () => {},
          learnSource: () => left,
          pads: () => [{
            slot: 1,
            preset: "p1",
            sources: [
              { source_id: left.selector, revision: "left-r1", preset: "left", routed: true },
              { source_id: right.selector, revision: "right-r1", preset: "right", routed: true },
            ],
          }],
          selectedSlot: () => "1",
          controlsFor: () => [],
          beginMutation: () => ({}),
          endMutation: () => {},
        });
        await KSXMapper.startLearn({
          fn: "a",
          label: "A",
          slot: "1",
          mode: "replace",
        });
      }, { left, right });

      assert.equal(await page.locator("#left .rd-keycue").evaluate((el) => el.classList.contains("none")), false);
      assert.match(await page.locator("#left .rd-keycue-text").innerText(), /Waiting/);
      assert.equal(await page.locator("#right .rd-keycue").evaluate((el) => el.classList.contains("none")), true);
      await page.evaluate(() => KSXMapper.cancelLearn());
      assert.equal(await page.locator("#left .rd-keycue").evaluate((el) => el.classList.contains("none")), true);
    } finally {
      await page.close();
    }
  });

  test("explicit and legacy assign cues stay on their authoring keyboard", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <main id="root">
          <div class="rd-learnbar none">
            <span class="rd-learn-line"></span><span class="rd-learn-sub"></span>
            <label class="rd-chain"><input class="rd-chain-box" type="checkbox"></label>
          </div>
          <section id="left" data-source-id="${left.selector}">
            <div class="n-kb"><button data-key="K">K</button></div>
            <div class="rd-keycue none"><span class="rd-keycue-text"></span></div>
          </section>
          <section id="right" data-source-id="${right.selector}">
            <div class="n-kb"><button data-key="K">K</button></div>
            <div class="rd-keycue none"><span class="rd-keycue-text"></span></div>
          </section>
        </main>
      `);
      await page.addScriptTag({ content: mapperBundle });
      await page.evaluate(({ left, right }) => {
        const sourceRows = [{
          slot: 1,
          preset: "p1",
          sources: [
            { source_id: left.selector, revision: "left-r1", preset: "left", routed: true },
            { source_id: right.selector, revision: "right-r1", preset: "right", routed: true },
          ],
        }];
        KSXMapper.mapperWire({
          root: () => document.querySelector("#root"),
          flash: () => {},
          refresh: async () => true,
          announce: () => {},
          learnSource: () => right,
          pads: () => sourceRows,
          selectedSlot: () => "1",
          controlsFor: () => [],
          beginMutation: () => ({}),
          endMutation: () => {},
        });
        KSXMapper.armAssign("K", "replace", left);
      }, { left, right });

      assert.equal(await page.locator("#left [data-key=K]").evaluate((el) => el.classList.contains("assign")), true);
      assert.equal(await page.locator("#right [data-key=K]").evaluate((el) => el.classList.contains("assign")), false);

      await page.evaluate(() => {
        KSXMapper.cancelAssign();
        KSXMapper.armAssign("K");
      });
      assert.equal(await page.locator("#left [data-key=K]").evaluate((el) => el.classList.contains("assign")), false);
      assert.equal(await page.locator("#right [data-key=K]").evaluate((el) => el.classList.contains("assign")), true);
      await page.evaluate(() => KSXMapper.cancelAssign());
    } finally {
      await page.close();
    }
  });

  test("independent same-key assignments POST each clicked source identity", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <main id="root">
          <div class="rd-learnbar none">
            <span class="rd-learn-line"></span><span class="rd-learn-sub"></span>
            <label class="rd-chain"><input class="rd-chain-box" type="checkbox"></label>
          </div>
          <section data-source-id="${serialUpper.selector}">
            <div class="n-kb"><button data-key="K">K</button></div>
          </section>
          <section data-source-id="${serialLower.selector}">
            <div class="n-kb"><button data-key="K">K</button></div>
          </section>
        </main>
      `);
      await page.addScriptTag({ content: mapperBundle });
      await page.evaluate(({ serialUpper, serialLower }) => {
        window.__mapperPosts = [];
        window.__mapperFlashes = [];
        window.__mapperRows = [{
          slot: 1,
          preset: "p1",
            sources: [
              { source_id: serialUpper.selector, revision: "upper-r1", preset: "upper", routed: true },
              { source_id: serialLower.selector, revision: "lower-r1", preset: "lower", routed: true },
          ],
        }];
        window.fetch = async (_input, init) => {
          window.__mapperPosts.push(JSON.parse(init.body));
          return new Response(JSON.stringify({
            ok: true,
            conflicts: [],
            also_drives: [],
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        };
        KSXMapper.mapperWire({
          root: () => document.querySelector("#root"),
          flash: (line) => window.__mapperFlashes.push(line),
          refresh: async () => {
            const written = window.__mapperPosts.at(-1)?.expected_device;
            const source = window.__mapperRows[0].sources.find(
              (candidate) => candidate.source_id === written,
            );
            source.revision = source.revision.endsWith("r1")
              ? source.revision.replace(/r1$/, "r2")
              : `${source.revision}-next`;
            return true;
          },
          announce: () => {},
          learnSource: () => serialUpper,
          pads: () => window.__mapperRows,
          selectedSlot: () => "1",
          controlsFor: () => [],
          beginMutation: () => ({}),
          endMutation: () => {},
        });
        KSXMapper.armAssign("K", "replace", serialUpper);
        KSXMapper.resolveAssignWithControl("1", "a", "A", false);
      }, { serialUpper, serialLower });
      await page.waitForFunction(() => window.__mapperPosts.length === 1);

      await page.evaluate((serialLower) => {
        KSXMapper.armAssign("K", "replace", serialLower);
        KSXMapper.resolveAssignWithControl("1", "a", "A", false);
      }, serialLower);
      await page.waitForFunction(() => window.__mapperPosts.length === 2);

      const posts = await page.evaluate(() => window.__mapperPosts);
      assert.deepEqual(posts.map((post) => ({
        key: post.key,
        expected_device: post.expected_device,
        expected_target_revision: post.expected_target_revision,
      })), [
        { key: "K", expected_device: serialUpper.selector, expected_target_revision: "upper-r1" },
        { key: "K", expected_device: serialLower.selector, expected_target_revision: "lower-r1" },
      ]);
      const errors = await page.evaluate(() =>
        window.__mapperFlashes.filter((line) => line.startsWith("error:"))
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});
