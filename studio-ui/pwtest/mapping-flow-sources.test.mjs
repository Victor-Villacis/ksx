// Source-qualified topology contract for the redesign mapping layer.
//
// Two independent physical keyboards may emit the same symbol into the same
// controller slot. The graph must retain both relationships and the browser
// layer must anchor/live-paint each cord at the originating surface.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = path.join(repoRoot, "studio-ui", "src", "mappingFlow.ts");

let browser;
let page;
let bundle;

const emptyMacro = {
  name: "Rapid",
  triggers: ["A"],
  outputs: [{ function: "a", steps: [1] }],
  timeline: ["1: a"],
  meta: "fixture",
  disabled: false,
  edit_href: "/redesign/macro?slot=1&name=Rapid",
};

const sourcePad = {
  slot: 1,
  preset: "legacy-ignored",
  title: "Player 1",
  fn_keys: { x: "Z" },
  fn_names: { a: "A", x: "X" },
  controls: [{
    function: "x",
    label: "X",
    group: "face",
    order: 0,
    keys: ["Z"],
    toggle: false,
    turbo_hz: null,
  }],
  sources: [
    {
      sourceId: "usb:1111:0001:00",
      sourceAlias: "left",
      preset: "left-map",
      fn_names: { a: "A" },
      controls: [{
        function: "a",
        label: "A",
        group: "face",
        order: 0,
        keys: ["A"],
        toggle: false,
        turbo_hz: null,
      }],
      macros: [emptyMacro],
    },
    {
      source_id: "usb:2222:0002:00",
      source_alias: "right",
      preset: "right-map",
      fn_names: { a: "A" },
      controls: [{
        function: "a",
        label: "A",
        group: "face",
        order: 0,
        keys: ["A"],
        toggle: false,
        turbo_hz: null,
      }],
      macros: [emptyMacro],
    },
  ],
};

before(async () => {
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "KSXMappingFlow",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  await page.setContent(`
    <style>
      #root { position: relative; width: 1000px; height: 620px; }
      #viewport { position: relative; width: 1000px; height: 620px; overflow: hidden; }
      #stage, #flow-lines, #flow-ports, #flow-nodes {
        position: absolute; inset: 0; width: 1000px; height: 620px;
      }
      .rd-keyboard-device-node { position: absolute; width: 190px; height: 90px; }
      #left { left: 40px; top: 70px; }
      #right { left: 40px; top: 250px; }
      [data-key] { width: 42px; height: 42px; margin: 20px; }
      .widget-instance { position: absolute; left: 750px; top: 180px; width: 140px; height: 140px; }
      .widget-instance svg { width: 140px; height: 140px; overflow: visible; }
      #flow-lines, #flow-ports { pointer-events: none; overflow: visible; }
    </style>
    <main id="root">
      <div id="viewport">
        <div id="stage">
          <section id="left" class="rd-dev-node rd-keyboard-device-node"
            data-selector="usb:1111:0001:00" data-source-id="usb:1111:0001:00"
            data-source-instance="HID\\VID_1111&amp;PID_0001\\LEFT">
            <form class="rd-stageform"><input name="alias" value="left"></form>
            <button id="left-a" data-key="A">A</button>
          </section>
          <section id="right" class="rd-dev-node rd-keyboard-device-node"
            data-selector="usb:2222:0002:00" data-source-id="usb:2222:0002:00"
            data-source-instance="HID\\VID_2222&amp;PID_0002\\RIGHT">
            <form class="rd-stageform"><input name="alias" value="right"></form>
            <button id="right-a" data-key="A">A</button>
          </section>
          <article class="widget-instance n-widget-pad">
            <svg data-pad-slot="1" viewBox="0 0 140 140">
              <rect id="pad-a" data-fn="a" x="45" y="45" width="50" height="50"></rect>
            </svg>
          </article>
        </div>
        <svg id="flow-lines" viewBox="0 0 1000 620"></svg>
        <svg id="flow-ports" viewBox="0 0 1000 620"></svg>
        <div id="flow-nodes"></div>
      </div>
    </main>
  `);
  await page.addScriptTag({ content: bundle });
});

async function settle() {
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
}

describe("mapping flow physical-source identity", { concurrency: false }, () => {
  test("one pad flattens two source tables without collapsing ids or legacy rows", async () => {
    const graph = await page.evaluate((pad) => KSXMappingFlow.deriveMappingFlow([pad]), sourcePad);
    const direct = graph.routes.filter((route) => route.kind === "binding");
    assert.equal(direct.length, 2);
    assert.equal(new Set(direct.map((route) => route.id)).size, 2);
    assert.deepEqual(
      direct.map((route) => [route.source.sourceId, route.source.sourceAlias, route.source.key]),
      [
        ["usb:1111:0001:00", "left", "A"],
        ["usb:2222:0002:00", "right", "A"],
      ],
    );
    assert.equal(direct.some((route) => route.source.key === "Z"), false);
    assert.equal(graph.processors.length, 2);
    assert.equal(new Set(graph.processors.map((processor) => processor.id)).size, 2);

    const aliasVariation = structuredClone(sourcePad);
    aliasVariation.sources.push({
      ...structuredClone(aliasVariation.sources[0]),
      sourceAlias: "renamed-left",
    });
    const deduped = await page.evaluate(
      (pad) => KSXMappingFlow.deriveDirectMappingFlow([pad]),
      aliasVariation,
    );
    assert.equal(deduped.length, 2, "alias presentation cannot duplicate an exact source route");
  });

  test("same-key cords anchor and live-paint only at their exact keyboard", async () => {
    await page.evaluate((pad) => {
      window.layer = new KSXMappingFlow.MappingFlowLayer(
        document.querySelector("#root"),
        document.querySelector("#viewport"),
        document.querySelector("#stage"),
        document.querySelector("#flow-lines"),
        document.querySelector("#flow-ports"),
        document.querySelector("#flow-nodes"),
      );
      window.layer.setGraph([pad], "all", 1);
    }, sourcePad);
    await settle();

    const routes = await page.locator('#flow-lines > [data-flow-kind="binding"]').evaluateAll(
      (groups) => groups.map((group) => ({
        source: group.getAttribute("data-flow-source-id"),
        unresolved: group.classList.contains("is-unresolved"),
        path: group.querySelector(".n-flow-core")?.getAttribute("d") ?? "",
      })),
    );
    assert.equal(routes.length, 2);
    assert.equal(routes.every((route) => !route.unresolved), true);
    assert.equal(new Set(routes.map((route) => route.path)).size, 2, "cords must use different key anchors");

    await page.evaluate(() => {
      window.layer.setLive(
        new Set([KSXMappingFlow.mappingLiveKeyToken(
          "A",
          "hid\\vid_1111&pid_0001\\left",
          "",
        )]),
        new Set(),
        new Map([[1, new Set(["a"])]]),
        new Map(),
      );
    });
    const liveSources = await page.locator(
      '#flow-lines > [data-flow-kind="binding"].is-live',
    ).evaluateAll((groups) => groups.map((group) => group.getAttribute("data-flow-source-id")));
    assert.deepEqual(liveSources, ["usb:1111:0001:00"]);
    await page.evaluate(() => window.layer.dispose());
  });

  test("an old unqualified route stays unresolved when two source nodes exist", async () => {
    const legacy = {
      ...sourcePad,
      sources: undefined,
      preset: "legacy",
      fn_keys: {},
      controls: [{
        function: "a",
        label: "A",
        group: "face",
        order: 0,
        keys: ["A"],
        toggle: false,
        turbo_hz: null,
      }],
      macros: [],
    };
    await page.evaluate((pad) => {
      window.layer = new KSXMappingFlow.MappingFlowLayer(
        document.querySelector("#root"),
        document.querySelector("#viewport"),
        document.querySelector("#stage"),
        document.querySelector("#flow-lines"),
        document.querySelector("#flow-ports"),
        document.querySelector("#flow-nodes"),
      );
      window.layer.setGraph([pad], "all", 1);
    }, legacy);
    await settle();
    const route = page.locator('#flow-lines > [data-flow-kind="binding"]');
    assert.equal(await route.count(), 1);
    assert.equal(await route.evaluate((group) => group.classList.contains("is-unresolved")), true);
    await page.evaluate(() => window.layer.dispose());
  });
});
