// Source-qualified controller-inspector and macro-editor writes.
//
// Two keyboards may feed one controller. Every mutating control therefore
// has to return the exact keyboard selector and the revision that painted it;
// a controller-level preset or revision must never authorize the write.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";
import { redesignSourceAuthorityFields } from "../src/redesign-controller-inspector.ts";
import {
  rdMacroEditPayload,
  rdMacroSavePayload,
  rdMacroSourceAuthority,
} from "../src/redesign-macro-editor.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const inspectorEntry = path.join(
  repoRoot,
  "studio-ui",
  "src",
  "redesign-controller-inspector.ts",
);

const LEFT = "usb:1111:0001:00";
const RIGHT = "usb:2222:0002:00";

const draft = {
  name: "dash",
  steps: [{ hold: ["a"], ms: 33, frames: null, allow_short: false }],
  on_release: "finish",
  retrigger: "restart",
  interrupt: "cancel",
  repeat: "once",
  turbo_hz: null,
  gap_ms: null,
  triggers: ["K"],
  disabled: true,
};

function macroView(overrides = {}) {
  return {
    slot: "1",
    preset: "compatibility-preset-must-not-authorize-the-write",
    source: RIGHT,
    source_revision: "right-r7",
    source_preset: "Right map",
    ...overrides,
  };
}

describe("redesign exact-source payloads", () => {
  test("inspector authority fields preserve the served selector and route revision", () => {
    assert.deepEqual(
      redesignSourceAuthorityFields({
        source: `  ${LEFT}  `,
        source_revision: " left-r3 ",
        source_preset: "not-posted-by-these-forms",
      }),
      [
        ["source", LEFT],
        ["expected_target_revision", "left-r3"],
      ],
    );
  });

  test("macro edit and save use one exact source authority", () => {
    assert.deepEqual(rdMacroSourceAuthority(macroView()), {
      source: RIGHT,
      revision: "right-r7",
      preset: "Right map",
    });
    assert.deepEqual(rdMacroEditPayload(macroView(), draft, "cell|0|a"), {
      slot: 1,
      source: RIGHT,
      expected_target_revision: "right-r7",
      act: "cell|0|a",
      draft,
    });
    assert.deepEqual(rdMacroSavePayload(macroView(), draft), {
      target: "stage",
      slot: 1,
      expected_device: RIGHT,
      expected_target_revision: "right-r7",
      preset: "Right map",
      name: "dash",
      steps: draft.steps,
      on_release: "finish",
      retrigger: "restart",
      interrupt: "cancel",
      repeat: "once",
      turbo_hz: null,
      gap_ms: null,
      enabled: false,
    });
  });

  test("macro writes fail closed when any source authority field is absent", () => {
    for (const missing of ["source", "source_revision", "source_preset"]) {
      const view = macroView({ [missing]: "" });
      assert.equal(rdMacroSourceAuthority(view), null, missing);
      assert.equal(rdMacroEditPayload(view, draft, "add"), null, missing);
      assert.equal(rdMacroSavePayload(view, draft), null, missing);
    }
  });
});

let browser;
let inspectorBundle;

before(async () => {
  const built = await build({
    entryPoints: [inspectorEntry],
    bundle: true,
    format: "iife",
    globalName: "KSXInspector",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  inspectorBundle = built.outputFiles[0].text;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

function bindRow() {
  return {
    function: "a",
    label: "A",
    chip: "K",
    note: "Face button",
    cls: "n-bind on",
    chip_cls: "n-keychip",
    minus_cls: "n-minus",
    clear_cls: "n-clear",
    slot: "1",
    turbo: "10",
    chip_title: "K drives A",
    badge: "toggle",
    badge_cls: "n-badge",
    add_cls: "n-addchip",
    hold_cls: "n-bpill",
    tog_cls: "n-bpill on",
  };
}

function keyRow() {
  return {
    key_label: "K",
    key: "K",
    targets: "A",
    fns: "a",
    cls: "n-krow on",
    slot: "1",
  };
}

function panel() {
  return {
    source: LEFT,
    source_revision: "left-r3",
    source_preset: "Left map",
    slot_val: "1",
    pad_badge: "P1",
    pad_badge_cls: "n-badge",
    pad_name: "Player 1",
    pad_sub: "Xbox controller",
    bind_title: "Mappings",
    bind_foot: "",
    bind_face: [bindRow()],
    bind_dpad: [],
    bind_shoulders: [],
    bind_lstick: [],
    bind_rstick: [],
    bind_system: [],
    avail_face: [],
    avail_dpad: [],
    avail_shoulders: [],
    avail_lstick: [],
    avail_rstick: [],
    avail_system: [],
    bind_face_n: "1",
    bind_dpad_n: "0",
    bind_shoulders_n: "0",
    bind_lstick_n: "0",
    bind_rstick_n: "0",
    bind_system_n: "0",
    bind_face_cls: "n-bindg",
    bind_dpad_cls: "n-bindg",
    bind_shoulders_cls: "n-bindg",
    bind_lstick_cls: "n-bindg",
    bind_rstick_cls: "n-bindg",
    bind_system_cls: "n-bindg",
    bind_g_cls: "n-bindings",
    socd_cls: "none",
    socd_num: "1",
    socd_lab: "Opposite directions",
    socd_current: "last",
    socd_edit_opts: [{ value: "last", label: "Last press wins" }],
  };
}

function keys() {
  return {
    source: RIGHT,
    source_revision: "right-r7",
    source_preset: "Right map",
    key_rows: [keyRow()],
    keys_note: "One mapped key",
    avail_main: [],
    avail_nav: [],
    avail_num: [],
    avail_main_head: "Main block",
    avail_nav_head: "Navigation",
    avail_num_head: "Numpad",
    avail_main_cls: "none",
    avail_nav_cls: "none",
    avail_num_cls: "none",
  };
}

function macros() {
  return {
    head: "Macros · 1",
    note: "",
    rows: [{
      name: "dash",
      fn_name: "macro.dash",
      chip: "K",
      chip_title: "K starts dash",
      add_cls: "n-addchip",
      chip_cls: "n-keychip",
      meta: "1 step",
      cls: "n-bind on",
      slot: "1",
      source: RIGHT,
      source_revision: "right-r7",
      preset: "Right map",
      edit_href: `/redesign?slot=1&source=${encodeURIComponent(RIGHT)}&macro=dash`,
      toggle_label: "Disable",
      toggle_value: "",
    }],
  };
}

describe("redesign inspector form authority", { concurrency: false }, () => {
  test("every source-owned form carries the authority that painted it", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<main id="root"></main>');
      await page.addScriptTag({ content: inspectorBundle });
      const forms = await page.evaluate(({ panel, keys, macros }) => {
        const root = document.querySelector("#root");
        const render = (tab) => {
          root.replaceChildren(
            ...window.KSXInspector.renderControllerPanel(panel, keys, macros, tab, () => {}),
          );
          return Array.from(root.querySelectorAll("form[data-rd-form]"), (form) => ({
            kind: form.dataset.rdForm,
            source: form.elements.namedItem("source")?.value ?? null,
            revision: form.elements.namedItem("expected_target_revision")?.value ?? null,
          }));
        };
        return { controls: render("controls"), keys: render("keys") };
      }, { panel: panel(), keys: keys(), macros: macros() });

      const byKind = (kind) => forms.controls.filter((form) => form.kind === kind);
      for (const kind of ["bind-clear", "bind-toggle", "bind-turbo", "bind-clear-all"]) {
        assert.ok(byKind(kind).length > 0, `${kind} is rendered`);
        for (const form of byKind(kind)) {
          assert.equal(form.source, LEFT, kind);
          assert.equal(form.revision, "left-r3", kind);
        }
      }
      for (const kind of ["macro-toggle", "macro-delete"]) {
        assert.deepEqual(byKind(kind), [{ kind, source: RIGHT, revision: "right-r7" }]);
      }
      assert.deepEqual(byKind("macro-new"), [{
        kind: "macro-new",
        source: LEFT,
        revision: "left-r3",
      }]);
      assert.deepEqual(
        forms.keys.filter((form) => form.kind === "key-clear"),
        [{ kind: "key-clear", source: RIGHT, revision: "right-r7" }],
      );

      const incomplete = macros();
      incomplete.rows[0].source_revision = "";
      const incompleteRow = await page.evaluate(({ panel, keys, macros }) => {
        const root = document.querySelector("#root");
        root.replaceChildren(
          ...window.KSXInspector.renderControllerPanel(
            panel,
            keys,
            macros,
            "controls",
            () => {},
          ),
        );
        const form = root.querySelector('form[data-rd-form="macro-toggle"]');
        return {
          source: form.elements.namedItem("source")?.value ?? null,
          revision: form.elements.namedItem("expected_target_revision")?.value ?? null,
        };
      }, { panel: panel(), keys: keys(), macros: incomplete });
      assert.deepEqual(
        incompleteRow,
        { source: RIGHT, revision: "" },
        "an exact row cannot borrow another keyboard's revision",
      );
    } finally {
      await page.close();
    }
  });
});
