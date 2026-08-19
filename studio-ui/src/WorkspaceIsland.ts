import { h, createSignal, createList, createShow } from "@getforma/core";

// ── /workspace — THE WORKSPACE (M2: the left pane grows real controls) ─────
//
// The destination: one three-pane screen — keyboard + player rack on the
// left, the controller and keyboard diagrams in the center, the binding list
// on the right — absorbing what /start, /map and / do today. M0 landed the
// frame; M2 grows the LEFT pane into a working surface: the staged board,
// the player rack (reorder, remove, opposite-directions rule), the keyboard
// capture answer, and the honest empty/dirty/unreachable states. The center
// and right panes still say where the working surfaces are.
//
// Two rules this page is built under, both inherited (see render.rs and
// docs/SURFACES.md §1):
//
// - **Every sentence is composed in Rust.** The payload's `view` field
//   (`WorkspaceDerived`, snapshot.rs) carries every displayed string, every
//   list row, every form value and every `show:` boolean; this island copies
//   fields and derives nothing, so the SSR paint and the 2 s poll cannot
//   disagree. Even the whole-order sequence a Move button submits is
//   precomposed there.
// - **Signals live HERE**, never in WorkspacePage.ts or workspace.ts (the
//   twin-declaration trap — docs/FORMA-DOGFOOD.md #9), and every workspace
//   signal carries a `ws` prefix so this page's many panes cannot collide.
//
// Compiler constraints honored below (see render.rs):
// - dynamic text/attrs must be bare `() => signalName()` calls;
// - createShow conditions must be bare `() => signalName()` too;
// - createShows are SIBLINGS, never nested;
// - list KEYS name every field the row renders (reconcile-by-key).

// ── Wire types ─────────────────────────────────────────────────────────────

/** One staged controller row — see `WorkspaceSlotRow` in snapshot.rs. */
export interface WorkspaceSlotRow {
  number: string;
  row_cls: string;
  href: string;
  title: string;
  detail: string;
  socd_note: string;
  up_order: string;
  down_order: string;
}

/** One binding-list row — see `WorkspaceBindRow` in snapshot.rs. */
export interface WorkspaceBindRow {
  function: string;
  label: string;
  keys: string;
  notes: string;
  cls: string;
  clear: string;
  slot: string;
}

/** One capture radio-row — see `WorkspaceChoiceRow` in snapshot.rs. */
export interface WorkspaceChoiceRow {
  name: string;
  title: string;
  detail: string;
  row_cls: string;
  button: string;
}

/** A served select option. */
export interface WorkspaceOptionRow {
  value: string;
  label: string;
}

/** Every displayed string and every `show:` branch, computed once, in Rust
 *  (`WorkspaceDerived` in snapshot.rs). This island reads nothing else. */
export interface WorkspaceDerived {
  state_detail: string;
  device_line: string;
  device_meta: string;
  rack_line: string;
  rack: WorkspaceSlotRow[];
  rack_caption: string;
  socd_slots: WorkspaceOptionRow[];
  socd_policies: WorkspaceOptionRow[];
  blocking_line: string;
  blocking: WorkspaceChoiceRow[];
  add_personas: WorkspaceOptionRow[];
  add_layouts: WorkspaceOptionRow[];
  add_preset: string;
  add_full_line: string;
  pad_caption: string;
  bind_title: string;
  bind_rows: WorkspaceBindRow[];
  bind_foot: string;
  map_href: string;
  dirty_line: string;
  pill_running: boolean;
  pill_idle: boolean;
  pill_down: boolean;
  stage_ready: boolean;
  stage_empty: boolean;
  has_device: boolean;
  show_dirty: boolean;
  can_add: boolean;
  add_full: boolean;
  pad_xbox: boolean;
  pad_ps: boolean;
}

/** What `GET /api/workspace` serves and what this island's payload block
 *  carries — one shape (`WorkspacePayload` in snapshot.rs), parity pinned in
 *  render_workspace.rs. `staged` and `session` are the raw provider reads;
 *  the panes render only the derived view, so they stay untyped here until a
 *  pane needs their fields. */
export interface WorkspacePayload {
  staged: unknown;
  session: unknown;
  view: WorkspaceDerived;
}

// ── Signals — this list IS the FMIR slot table ─────────────────────────────

const [wsStateDetail, setWsStateDetail] = createSignal("");
const [wsDeviceLine, setWsDeviceLine] = createSignal("");
const [wsDeviceMeta, setWsDeviceMeta] = createSignal("");
const [wsRackLine, setWsRackLine] = createSignal("");
const [wsRackCaption, setWsRackCaption] = createSignal("");
const [wsBlockingLine, setWsBlockingLine] = createSignal("");
const [wsDirtyLine, setWsDirtyLine] = createSignal("");
const [wsAddPreset, setWsAddPreset] = createSignal("");
const [wsAddFullLine, setWsAddFullLine] = createSignal("");
const [wsPadCaption, setWsPadCaption] = createSignal("");
const [wsBindTitle, setWsBindTitle] = createSignal("");
const [wsBindFoot, setWsBindFoot] = createSignal("");
const [wsMapHref, setWsMapHref] = createSignal("/map");
const [wsBindRows, setWsBindRows] = createSignal<WorkspaceBindRow[]>([]);

const [wsRackRows, setWsRackRows] = createSignal<WorkspaceSlotRow[]>([]);
const [wsBlockingRows, setWsBlockingRows] = createSignal<WorkspaceChoiceRow[]>([]);
const [wsSocdSlotOptions, setWsSocdSlotOptions] = createSignal<WorkspaceOptionRow[]>([]);
const [wsSocdPolicyOptions, setWsSocdPolicyOptions] = createSignal<WorkspaceOptionRow[]>([]);
const [wsAddPersonaOptions, setWsAddPersonaOptions] = createSignal<WorkspaceOptionRow[]>([]);
const [wsAddLayoutOptions, setWsAddLayoutOptions] = createSignal<WorkspaceOptionRow[]>([]);

const [wsPillRunning, setWsPillRunning] = createSignal(false);
const [wsPillIdle, setWsPillIdle] = createSignal(false);
const [wsPillDown, setWsPillDown] = createSignal(false);
const [wsStageReady, setWsStageReady] = createSignal(false);
const [wsStageEmpty, setWsStageEmpty] = createSignal(false);
const [wsHasDevice, setWsHasDevice] = createSignal(false);
const [wsShowDirty, setWsShowDirty] = createSignal(false);
const [wsCanAdd, setWsCanAdd] = createSignal(false);
const [wsAddFull, setWsAddFull] = createSignal(false);
const [wsPadXbox, setWsPadXbox] = createSignal(false);
const [wsPadPs, setWsPadPs] = createSignal(false);

// The action flash. SSR-only: the server fills these from the allowlisted
// query parameter; a poll is not an action and never touches them.
const [wsFlashLine] = createSignal("");
const [wsFlashOk] = createSignal(false);
const [wsFlashError] = createSignal(false);

// ── Appliers — copiers, never derivers ─────────────────────────────────────

export function applyWorkspace(p: WorkspacePayload): void {
  setWsStateDetail(p.view.state_detail);
  setWsDeviceLine(p.view.device_line);
  setWsDeviceMeta(p.view.device_meta);
  setWsRackLine(p.view.rack_line);
  setWsRackCaption(p.view.rack_caption);
  setWsBlockingLine(p.view.blocking_line);
  setWsDirtyLine(p.view.dirty_line);
  setWsAddPreset(p.view.add_preset);
  setWsAddFullLine(p.view.add_full_line);
  setWsPadCaption(p.view.pad_caption);
  setWsBindTitle(p.view.bind_title);
  setWsBindFoot(p.view.bind_foot);
  setWsMapHref(p.view.map_href);
  setWsBindRows(p.view.bind_rows);
  setWsRackRows(p.view.rack);
  setWsBlockingRows(p.view.blocking);
  setWsSocdSlotOptions(p.view.socd_slots);
  setWsSocdPolicyOptions(p.view.socd_policies);
  setWsAddPersonaOptions(p.view.add_personas);
  setWsAddLayoutOptions(p.view.add_layouts);
  setWsPillRunning(p.view.pill_running);
  setWsPillIdle(p.view.pill_idle);
  setWsPillDown(p.view.pill_down);
  setWsStageReady(p.view.stage_ready);
  setWsStageEmpty(p.view.stage_empty);
  setWsHasDevice(p.view.has_device);
  setWsShowDirty(p.view.show_dirty);
  setWsCanAdd(p.view.can_add);
  setWsAddFull(p.view.add_full);
  setWsPadXbox(p.view.pad_xbox);
  setWsPadPs(p.view.pad_ps);
}

/** The poll failed: the page's OWN server is gone, which is a different fact
 *  from an unreachable daemon and gets its own sentence. The one string this
 *  file words, because only the client can know it. */
export function applyWorkspaceUnreachable(): void {
  setWsStateDetail("ksx Studio is not answering. Reopen ksx.");
  setWsPillRunning(false);
  setWsPillIdle(false);
  setWsPillDown(true);
}

// ── The stage schematics ───────────────────────────────────────────────────
//
// Two controllers, one design language. The SHELLS are the vendored
// Gamepad-Asset-Pack silhouettes (MIT, AL2009man — the same art the /pads
// tiles ship, credited in every footer), so the outlines are real controller
// geometry rather than a traced guess. The CONTROL layer on top is ours:
// zone wells, sticks, dpad, face glyphs and the trigger strip, every fill
// and stroke a token class so both themes come from one piece of art. The
// PlayStation variant is a real DualShock — touchpad, petal dpad, shape
// glyphs, L1/L2 vocabulary — not the Xbox outline with renamed labels.
// Decorative in M2 (aria-hidden; the caption is the accessible summary);
// the zones grow data-fn overlays with M3.


export function WorkspaceIsland() {
  return h(
    "div",
    { class: "studio wsroot" },
    h(
      "header",
      { class: "wstbar" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-ksx" }, "ksx"),
        h("span", { class: "brand-studio" }, "Studio"),
        h("span", { class: "wstag" }, "workspace preview"),
      ),
      h("div", { class: "wstbar-spring" }),
      createShow(
        () => wsPillRunning(),
        () => h("span", { class: "pill pill-run" }, "running"),
      ),
      createShow(
        () => wsPillIdle(),
        () => h("span", { class: "pill pill-idle" }, "ready"),
      ),
      createShow(
        () => wsPillDown(),
        () => h("span", { class: "pill pill-warn" }, "reopen ksx"),
      ),
      h(
        "details",
        { class: "appmenu" },
        h("summary", { class: "navlink on", "aria-label": "Open Studio tools" }, "Tools"),
        h(
          "nav",
          { class: "appmenu-panel", "aria-label": "Studio tools" },
          h("a", { href: "/start" }, h("span", null, "Guided setup"), h("small", null, "Keyboard, controller, mapping")),
          h("a", { href: "/" }, h("span", null, "Play status"), h("small", null, "Session and system state")),
          h("a", { href: "/map" }, h("span", null, "Controls"), h("small", null, "Edit button mappings")),
          h("a", { href: "/check" }, h("span", null, "Test inputs"), h("small", null, "Live controller feedback")),
          h("a", { href: "/profiles" }, h("span", null, "Game library"), h("small", null, "Saved launch profiles")),
          h("a", { href: "/devices" }, h("span", null, "Hardware"), h("small", null, "Devices and recovery")),
          h("a", { href: "/pads" }, h("span", null, "Virtual controllers"), h("small", null, "Inspect and test pads")),
          h("a", { href: "/setup" }, h("span", null, "Import & recovery"), h("small", null, "Advanced configuration")),
        ),
      ),
    ),
    createShow(
      () => wsFlashOk(),
      () => h("p", { class: "flash", role: "status" }, () => wsFlashLine()),
    ),
    createShow(
      () => wsFlashError(),
      () => h("p", { class: "flash flash-err", role: "status" }, () => wsFlashLine()),
    ),
    h(
      "main",
      { class: "wsmain" },
      h(
        "aside",
        { class: "wspane" },
        // ── Keyboard ────────────────────────────────────────────────────────
        h("h2", { class: "wskicker" }, "Keyboard"),
        h("p", { class: "wsline" }, () => wsDeviceLine()),
        createShow(
          () => wsHasDevice(),
          () => h("p", { class: "wsmeta" }, () => wsDeviceMeta()),
        ),
        h(
          "form",
          { class: "wsform", method: "post", action: "/workspace/device/identify" },
          h(
            "button",
            { class: "btn btn-ghost", type: "submit", "data-identify-submit": "" },
            "Identify by pressing a key",
          ),
        ),
        h(
          "a",
          { class: "wsmeta wslink", href: "/start" },
          "Change, rescan or prepare the keyboard in guided setup",
        ),
        // ── The player rack ─────────────────────────────────────────────────
        h("h2", { class: "wskicker" }, "Virtual controllers"),
        h("p", { class: "wsline" }, () => wsRackLine()),
        h(
          "ul",
          { class: "wsrack" },
          createList(
            () => wsRackRows(),
            (s) =>
              s.number +
              "|" +
              s.row_cls +
              "|" +
              s.href +
              "|" +
              s.title +
              "|" +
              s.detail +
              "|" +
              s.socd_note +
              "|" +
              s.up_order +
              "|" +
              s.down_order,
            (s) =>
              h(
                "li",
                { class: s.row_cls },
                h(
                  "div",
                  { class: "wsrow-head" },
                  h("a", { class: "wsrow-title", href: s.href }, s.title),
                  h("span", { class: "wsrow-note" }, s.socd_note),
                ),
                h("p", { class: "wsrow-detail" }, s.detail),
                h(
                  "div",
                  { class: "wsrow-acts" },
                  h(
                    "form",
                    { method: "post", action: "/workspace/controller/move" },
                    h("input", { type: "hidden", name: "number", value: s.number }),
                    h("input", { type: "hidden", name: "order", value: s.up_order }),
                    h("button", { class: "btn btn-ghost", type: "submit" }, "Move up"),
                  ),
                  h(
                    "form",
                    { method: "post", action: "/workspace/controller/move" },
                    h("input", { type: "hidden", name: "number", value: s.number }),
                    h("input", { type: "hidden", name: "order", value: s.down_order }),
                    h("button", { class: "btn btn-ghost", type: "submit" }, "Move down"),
                  ),
                  h(
                    "form",
                    { method: "post", action: "/workspace/controller/duplicate" },
                    h("input", { type: "hidden", name: "number", value: s.number }),
                    h("button", { class: "btn btn-ghost", type: "submit" }, "Duplicate"),
                  ),
                  h(
                    "form",
                    { method: "post", action: "/workspace/controller/remove" },
                    h("input", { type: "hidden", name: "number", value: s.number }),
                    h("button", { class: "btn btn-ghost", type: "submit" }, "Remove"),
                  ),
                ),
              ),
          ),
        ),
        h("p", { class: "wsmeta" }, () => wsRackCaption()),
        createShow(
          () => wsCanAdd(),
          () =>
            h(
              "form",
              { class: "wsform", method: "post", action: "/workspace/controller" },
              h(
                "label",
                { class: "bindlabel", for: "ws-add-persona" },
                "Add",
                h(
                  "select",
                  { id: "ws-add-persona", name: "persona" },
                  createList(
                    () => wsAddPersonaOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              h(
                "label",
                { class: "bindlabel", for: "ws-add-layout" },
                "starting from",
                h(
                  "select",
                  { id: "ws-add-layout", name: "layout" },
                  createList(
                    () => wsAddLayoutOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              // The preset name is SERVED, because it becomes a file name.
              h("input", { type: "hidden", name: "preset", value: () => wsAddPreset() }),
              h("button", { class: "btn btn-primary", type: "submit" }, "Add this controller"),
            ),
        ),
        createShow(
          () => wsAddFull(),
          () => h("p", { class: "wsmeta" }, () => wsAddFullLine()),
        ),
        createShow(
          () => wsStageReady(),
          () =>
            h(
              "form",
              { class: "wsform", method: "post", action: "/workspace/controller/socd" },
              h(
                "label",
                { class: "bindlabel", for: "ws-socd-slot" },
                "Opposite directions on",
                h(
                  "select",
                  { id: "ws-socd-slot", name: "number" },
                  createList(
                    () => wsSocdSlotOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              h(
                "label",
                { class: "bindlabel", for: "ws-socd-policy" },
                "do",
                h(
                  "select",
                  { id: "ws-socd-policy", name: "socd" },
                  createList(
                    () => wsSocdPolicyOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              h("button", { class: "btn", type: "submit" }, "Set the rule"),
            ),
        ),
        createShow(
          () => wsShowDirty(),
          () => h("p", { class: "wsdirty" }, () => wsDirtyLine()),
        ),
        // ── Keyboard capture ────────────────────────────────────────────────
        h("h2", { class: "wskicker" }, "Keyboard capture"),
        h("p", { class: "wsline" }, () => wsBlockingLine()),
        h(
          "ul",
          { class: "wsrack" },
          createList(
            () => wsBlockingRows(),
            (o) => o.name + "|" + o.title + "|" + o.detail + "|" + o.row_cls + "|" + o.button,
            (o) =>
              h(
                "li",
                { class: o.row_cls },
                h(
                  "div",
                  { class: "wsrow-head" },
                  h("span", { class: "wsrow-title" }, o.title),
                ),
                h("p", { class: "wsrow-detail" }, o.detail),
                h(
                  "form",
                  { method: "post", action: "/workspace/blocking" },
                  h("input", { type: "hidden", name: "blocking", value: o.name }),
                  h("button", { class: "btn btn-ghost", type: "submit" }, o.button),
                ),
              ),
          ),
        ),
        // ── The empty draft's two roads in ──────────────────────────────────
        createShow(
          () => wsStageEmpty(),
          () =>
            h(
              "div",
              { class: "wsemptyrow" },
              h("a", { class: "wsempty", href: "/start" }, "Build this draft in guided setup"),
              h(
                "form",
                { method: "post", action: "/workspace/adopt" },
                h(
                  "button",
                  { class: "btn btn-ghost", type: "submit" },
                  "Show the saved setup here",
                ),
              ),
            ),
        ),
      ),
      h(
        "section",
        { class: "wsstage-col" },
        h(
          "div",
          { class: "wsstage" },
          // The stage controller: the vendored silhouette matching the first
          // controller's family, with our token-painted control layer on
          // top (see xboxPad/psPad above). Which one shows is the server's
          // call (`pad_ps`), copied like every other show pair.
          createShow(
            () => wsPadXbox(),
            () =>
              h(
      "svg",
      { class: "wspad", viewBox: "0 0 112.45 96", "aria-hidden": "true", focusable: "false" },
      h(
      "g",
      null,
      h("rect", { class: "wspad-zone", x: "20", y: "1", width: "22", height: "6.4", rx: "3.2" }),
      h("rect", { class: "wspad-zone", x: "70.5", y: "1", width: "22", height: "6.4", rx: "3.2" }),
      h("text", { class: "wspad-sys", x: "31", y: "5.6", "text-anchor": "middle" }, "LT"),
      h("text", { class: "wspad-sys", x: "81.5", y: "5.6", "text-anchor": "middle" }, "RT"),
      h("rect", { class: "wspad-zone", x: "15", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
      h("rect", { class: "wspad-zone", x: "65.5", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
      h("text", { class: "wspad-sys", x: "31", y: "14.6", "text-anchor": "middle" }, "LB"),
      h("text", { class: "wspad-sys", x: "81.5", y: "14.6", "text-anchor": "middle" }, "RB"),
    ),
      h(
        "g",
        { transform: "translate(0,18.5)" },
        // The vendored Xbox One/Series silhouette, exactly as /pads ships it.
        h("path", {
          class: "wspad-shell",
          transform: "matrix(0.26458333,0,0,0.26458333,-0.79055,-0.40979)",
          d: "M 137.05469,1.5488281 68.955078,25.302734 67.365234,34.150391 C 67.142167,33.882724 50.374545,53.23716 43.234375,69.703125 34.488662,89.871667 14.09017,150.9152 7.6816406,185.11523 c -9.057222,48.33536 -5.5726825,68.26275 15.4218754,88.23438 8.949354,8.51331 20.320312,17.94922 20.320312,17.94922 0,0 83.911802,-73.96764 84.685552,-74.09766 11.69504,-1.96688 163.09317,-1.96709 174.78906,0 0.77373,0.13013 84.68554,74.09766 84.68554,74.09766 0,0 11.37096,-9.43591 20.32032,-17.94922 20.99455,-19.97163 24.47906,-39.89902 15.42187,-88.23438 C 416.91764,150.91516 396.51914,89.871651 387.77344,69.703125 380.63327,53.237131 363.86565,33.882707 363.64258,34.150391 L 362.05273,25.302734 293.95312,1.5488281 272.36719,17.996094 H 158.64062 Z",
        }),
        // Guide, with the accent lamp — the one deliberate spot of color.
        h("circle", { class: "wspad-well", cx: "56.23", cy: "11.59", r: "4.6" }),
        h("circle", { class: "wspad-guide", cx: "56.23", cy: "11.59", r: "2" }),
        // View · Menu.
        h("circle", { class: "wspad-zone", cx: "49.48", cy: "22.29", r: "2.6" }),
        h("circle", { class: "wspad-zone", cx: "62.98", cy: "22.29", r: "2.6" }),
        // Left stick (upper-left, the Xbox asymmetry) and right stick.
        h("circle", { class: "wspad-well", cx: "26.97", cy: "22.89", r: "10.2" }),
        h("circle", { class: "wspad-stick", cx: "26.97", cy: "22.89", r: "6.9" }),
        h("circle", { class: "wspad-well", cx: "70.3", cy: "39.57", r: "10.2" }),
        h("circle", { class: "wspad-stick", cx: "70.3", cy: "39.57", r: "6.9" }),
        // Dpad: one rounded cross, lower-left of centre.
        h("path", {
          class: "wspad-zone",
          transform: "translate(40.87,40.87)",
          d: "M -2.9,-9.2 h 5.8 v 6.3 h 6.3 v 5.8 h -6.3 v 6.3 h -5.8 v -6.3 h -6.3 v -5.8 h 6.3 z",
        }),
        // The face diamond, letters and all.
        h("circle", { class: "wspad-zone", cx: "84.61", cy: "15.27", r: "4.3" }),
        h("circle", { class: "wspad-zone", cx: "92.2", cy: "22.85", r: "4.3" }),
        h("circle", { class: "wspad-zone", cx: "84.66", cy: "30.57", r: "4.3" }),
        h("circle", { class: "wspad-zone", cx: "77.21", cy: "22.92", r: "4.3" }),
        h("text", { class: "wspad-face", x: "84.61", y: "16.9", "text-anchor": "middle" }, "Y"),
        h("text", { class: "wspad-face", x: "92.2", y: "24.5", "text-anchor": "middle" }, "B"),
        h("text", { class: "wspad-face", x: "84.66", y: "32.2", "text-anchor": "middle" }, "A"),
        h("text", { class: "wspad-face", x: "77.21", y: "24.55", "text-anchor": "middle" }, "X"),
      ),
    ),
          ),
          createShow(
            () => wsPadPs(),
            () =>
              h(
      "svg",
      { class: "wspad", viewBox: "0 0 112.69 92", "aria-hidden": "true", focusable: "false" },
      h(
      "g",
      null,
      h("rect", { class: "wspad-zone", x: "20", y: "1", width: "22", height: "6.4", rx: "3.2" }),
      h("rect", { class: "wspad-zone", x: "70.5", y: "1", width: "22", height: "6.4", rx: "3.2" }),
      h("text", { class: "wspad-sys", x: "31", y: "5.6", "text-anchor": "middle" }, "L2"),
      h("text", { class: "wspad-sys", x: "81.5", y: "5.6", "text-anchor": "middle" }, "R2"),
      h("rect", { class: "wspad-zone", x: "15", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
      h("rect", { class: "wspad-zone", x: "65.5", y: "10.4", width: "32", height: "5.6", rx: "2.8" }),
      h("text", { class: "wspad-sys", x: "31", y: "14.6", "text-anchor": "middle" }, "L1"),
      h("text", { class: "wspad-sys", x: "81.5", y: "14.6", "text-anchor": "middle" }, "R1"),
    ),
      h(
        "g",
        { transform: "translate(0,18.5)" },
        // The vendored DualShock silhouette, exactly as /pads ships it.
        h("path", {
          class: "wspad-shell",
          transform: "translate(-26.849948,-130.35184)",
          d: "m 48.4429,130.35201 c -2.656321,0.002 -5.205853,1.07801 -7.101494,2.99569 l -0.0057,-0.006 c -0.543507,0.54745 -1.098321,1.10607 -1.766298,2.11925 -0.667974,1.01319 -1.449449,2.47725 -2.442013,4.66586 -0.992562,2.18863 -2.195525,5.10062 -3.130175,7.74217 -0.93465,2.64154 -1.600236,5.01268 -2.344001,8.06669 -0.743765,3.054 -1.566531,6.79477 -2.252212,10.36887 -0.685683,3.57409 -1.234914,6.98145 -1.666211,10.78125 -0.431294,3.79979 -0.744851,7.98921 -1.05843,12.17755 l 0.0052,5.3e-4 c -0.01899,0.28002 -0.02902,0.5606 -0.03008,0.84129 -3e-6,7.05731 5.55134,12.77843 12.399351,12.77855 5.847836,-5.3e-4 10.900403,-4.21164 12.123982,-10.10481 1.382724,-4.83452 2.76621,-9.66981 3.610381,-12.32586 0.422087,-1.32802 0.710036,-2.11109 0.936565,-2.59002 0.22653,-0.47893 0.37992,-0.64455 0.56059,-0.77722 0.09034,-0.0663 0.164736,-0.11328 0.380122,-0.16019 0.188466,-0.041 0.490903,-0.0763 0.960937,-0.10646 1.873045,1.96002 4.430062,3.06486 7.099419,3.06752 2.757373,-5.3e-4 5.391548,-1.17723 7.277292,-3.25045 6.91036,-0.0284 15.424475,-0.0399 22.013906,-0.017 1.886814,2.08385 4.528252,3.26716 7.293889,3.2675 2.59502,-0.002 5.08708,-1.04648 6.94748,-2.91093 0.27817,0.0481 0.47234,0.1011 0.64149,0.15916 0.78442,0.26923 1.13782,0.61666 1.6268,1.62884 0.48898,1.01219 1.08143,2.66601 1.86379,5.02502 0.78234,2.35902 1.75609,5.42473 2.73034,8.49044 l 0.008,-0.003 c 1.02509,6.12639 6.17972,10.60355 12.21214,10.6071 6.84801,-1.2e-4 12.39935,-5.72124 12.39935,-12.77855 -0.003,-0.8035 -0.0793,-1.60493 -0.22818,-2.39365 l 0.007,-5.3e-4 c -0.23788,-2.90974 -0.47492,-5.82205 -0.94486,-9.36325 -0.46992,-3.54121 -1.17227,-7.70778 -1.93432,-11.66234 -0.76205,-3.95456 -1.5852,-7.69624 -2.32896,-10.75024 -0.74377,-3.05401 -1.40937,-5.42463 -2.34401,-8.06618 -0.93466,-2.64154 -2.13553,-5.55353 -3.1281,-7.74216 -0.99256,-2.18861 -1.77611,-3.65268 -2.44408,-4.66587 -0.66798,-1.01319 -1.22072,-1.5718 -1.76423,-2.11925 l -0.0129,0.0124 c -1.89832,-1.92388 -4.4541,-3.00212 -7.11656,-3.00234 -3.26568,0.002 -6.33073,1.62411 -8.23615,4.35735 H 56.685815 c -1.906805,-2.73523 -4.974838,-4.35705 -8.242898,-4.35735 z",
        }),
        // The touchpad — the DualShock's signature, front and centre.
        h("rect", { class: "wspad-touch", x: "37.11", y: "6.5", width: "38.39", height: "18.31", rx: "1.74" }),
        // Create · Options, the slim edge buttons beside it.
        h("rect", { class: "wspad-zone", x: "32.6", y: "7.2", width: "2.4", height: "5.2", rx: "1.2" }),
        h("rect", { class: "wspad-zone", x: "77.6", y: "7.2", width: "2.4", height: "5.2", rx: "1.2" }),
        // Dpad: the four petals, from the vendored art's own geometry.
        h(
          "g",
          { class: "wspad-petals", transform: "translate(-26.849948,-130.35184)" },
          h("path", { d: "m 57.303118,151.6163 c 0,1.25891 -0.201292,2.31652 -0.692974,2.8445 -0.440536,0.47354 -0.89262,0.58903 -1.407403,0.53623 -0.513135,-0.0528 -3.128295,-0.26234 -3.128295,-0.26234 0,0 -0.483433,-0.0957 -0.829925,-0.38938 -0.259041,-0.22109 -1.889184,-1.83639 -1.889184,-1.83639 0,0 -0.356388,-0.33659 -0.356388,-0.89262 0,-0.55603 0.356388,-0.89262 0.356388,-0.89262 0,0 1.630143,-1.61695 1.889184,-1.83804 0.346492,-0.29369 0.829925,-0.38774 0.829925,-0.38774 0,0 2.61516,-0.21119 3.128295,-0.26234 0.514783,-0.0528 0.966867,0.0627 1.407403,0.53458 0.491682,0.52799 0.692974,1.5856 0.692974,2.84616" }),
          h("path", { d: "m 37.936241,151.6163 c 0,1.25891 0.201292,2.31652 0.692974,2.8445 0.440536,0.47354 0.89262,0.58903 1.407403,0.53623 0.513135,-0.0528 3.128295,-0.26234 3.128295,-0.26234 0,0 0.483433,-0.0957 0.829925,-0.38938 0.259041,-0.22109 1.889184,-1.83639 1.889184,-1.83639 0,0 0.356388,-0.33659 0.356388,-0.89262 0,-0.55603 -0.356388,-0.89262 -0.356388,-0.89262 0,0 -1.630143,-1.61695 -1.889184,-1.83804 -0.346492,-0.29369 -0.829925,-0.38774 -0.829925,-0.38774 0,0 -2.61516,-0.21119 -3.128295,-0.26234 -0.514783,-0.0528 -0.966867,0.0627 -1.407403,0.53458 -0.491682,0.52799 -0.692974,1.5856 -0.692974,2.84616" }),
          h("path", { d: "m 47.730582,161.09428 c -1.25891,0 -2.31652,-0.20129 -2.8445,-0.69298 -0.47354,-0.44053 -0.58903,-0.89262 -0.53623,-1.4074 0.0528,-0.51313 0.26234,-3.12829 0.26234,-3.12829 0,0 0.0957,-0.48344 0.38938,-0.82993 0.22109,-0.25904 1.83639,-1.88918 1.83639,-1.88918 0,0 0.33659,-0.35639 0.89262,-0.35639 0.55603,0 0.89262,0.35639 0.89262,0.35639 0,0 1.61695,1.63014 1.83804,1.88918 0.29369,0.34649 0.38774,0.82993 0.38774,0.82993 0,0 0.21119,2.61516 0.26234,3.12829 0.0528,0.51478 -0.0627,0.96687 -0.53458,1.4074 -0.52799,0.49169 -1.5856,0.69298 -2.84616,0.69298" }),
          h("path", { d: "m 47.666334,141.82316 c -1.25891,0 -2.31652,0.20129 -2.8445,0.69297 -0.47354,0.44054 -0.58903,0.89262 -0.53623,1.40741 0.0528,0.51313 0.26234,3.12829 0.26234,3.12829 0,0 0.0957,0.48343 0.38938,0.82993 0.22109,0.25904 1.83639,1.88918 1.83639,1.88918 0,0 0.33659,0.35639 0.89262,0.35639 0.55603,0 0.89262,-0.35639 0.89262,-0.35639 0,0 1.61695,-1.63014 1.83804,-1.88918 0.29369,-0.3465 0.38774,-0.82993 0.38774,-0.82993 0,0 0.21119,-2.61516 0.26234,-3.12829 0.0528,-0.51479 -0.0627,-0.96687 -0.53458,-1.40741 -0.52799,-0.49168 -1.5856,-0.69297 -2.84616,-0.69297" }),
        ),
        // Sticks: symmetric and low, the PlayStation way.
        h("circle", { class: "wspad-well", cx: "38.1", cy: "36.12", r: "9.6" }),
        h("circle", { class: "wspad-stick", cx: "38.1", cy: "36.12", r: "6.6" }),
        h("circle", { class: "wspad-well", cx: "74.46", cy: "36.12", r: "9.6" }),
        h("circle", { class: "wspad-stick", cx: "74.46", cy: "36.12", r: "6.6" }),
        // The face shapes, drawn as SHAPES: triangle, circle, cross, square.
        h("circle", { class: "wspad-zone", cx: "91.52", cy: "12.85", r: "4.1" }),
        h("circle", { class: "wspad-zone", cx: "99.61", cy: "20.89", r: "4.1" }),
        h("circle", { class: "wspad-zone", cx: "91.56", cy: "28.79", r: "4.1" }),
        h("circle", { class: "wspad-zone", cx: "83.37", cy: "20.82", r: "4.1" }),
        h("path", { class: "wspad-glyph", d: "M 91.52,10.95 94.535,15.05 88.505,15.05 Z" }),
        h("circle", { class: "wspad-glyph", cx: "99.61", cy: "20.89", r: "1.9" }),
        h("path", { class: "wspad-glyph", d: "M 89.86,27.09 93.26,30.49 M 93.26,27.09 89.86,30.49" }),
        h("rect", { class: "wspad-glyph", x: "81.67", y: "19.12", width: "3.4", height: "3.4" }),
        // The PS lamp.
        h("circle", { class: "wspad-well", cx: "56.34", cy: "41.33", r: "3.4" }),
        h("circle", { class: "wspad-guide", cx: "56.34", cy: "41.33", r: "1.7" }),
      ),
    ),
          ),
          h("p", { class: "wsstate" }, () => wsStateDetail()),
          h("p", { class: "wsmeta" }, () => wsPadCaption()),
          h(
            "p",
            { class: "wsnote" },
            "The zone-by-zone binding surface is being built here. Until it lands, Controls in the Tools menu remains the working mapper.",
          ),
        ),
      ),
      h(
        "aside",
        { class: "wspane" },
        h("h2", { class: "wskicker" }, "Bindings"),
        h("p", { class: "wsline" }, () => wsBindTitle()),
        h(
          "ul",
          { class: "wsbinds" },
          createList(
            () => wsBindRows(),
            (b) =>
              b.function +
              "|" +
              b.label +
              "|" +
              b.keys +
              "|" +
              b.notes +
              "|" +
              b.cls +
              "|" +
              b.clear +
              "|" +
              b.slot,
            (b) =>
              h(
                "li",
                { class: b.cls },
                h(
                  "div",
                  { class: "wsbind-head" },
                  h("span", { class: "wsbind-label" }, b.label),
                  h("span", { class: "wsbind-keys" }, b.keys),
                ),
                h("p", { class: "wsbind-notes" }, b.notes),
                h(
                  "form",
                  { class: "wsbind-clear", method: "post", action: "/workspace/bind/clear" },
                  h("input", { type: "hidden", name: "slot", value: b.slot }),
                  h("input", { type: "hidden", name: "function", value: b.function }),
                  h("button", { class: "btn btn-ghost", type: "submit" }, b.clear),
                ),
              ),
          ),
        ),
        h("p", { class: "wsmeta" }, () => wsBindFoot()),
        h(
          "a",
          { class: "wsempty", href: () => wsMapHref() },
          "Rebind, chords and macros in Controls",
        ),
      ),
    ),
  );
}
