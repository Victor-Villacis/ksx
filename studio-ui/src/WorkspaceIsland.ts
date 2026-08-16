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
  title: string;
  detail: string;
  socd_note: string;
  up_order: string;
  down_order: string;
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
                { class: "wsrow" },
                h(
                  "div",
                  { class: "wsrow-head" },
                  h("span", { class: "wsrow-title" }, s.title),
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
          // The Nocturne schematic (640×400): the prototype's exact geometry,
          // repainted with the existing token ladder via CSS classes. ART in
          // M2 — aria-hidden, pointer-events none; the interactive zone
          // overlay and live lighting arrive with M3/M4. The caption below it
          // is the accessible summary meanwhile.
          h(
            "svg",
            {
              class: "wspad",
              viewBox: "0 0 640 400",
              "aria-hidden": "true",
              focusable: "false",
            },
            h("rect", { class: "wspad-zone", x: "150", y: "18", width: "80", height: "27", rx: "11" }),
            h("rect", { class: "wspad-zone", x: "410", y: "18", width: "80", height: "27", rx: "11" }),
            h("text", { class: "wspad-sys", x: "190", y: "36", "text-anchor": "middle" }, "LT"),
            h("text", { class: "wspad-sys", x: "450", y: "36", "text-anchor": "middle" }, "RT"),
            h("rect", { class: "wspad-zone", x: "130", y: "54", width: "112", height: "24", rx: "12" }),
            h("rect", { class: "wspad-zone", x: "398", y: "54", width: "112", height: "24", rx: "12" }),
            h("text", { class: "wspad-sys", x: "186", y: "70", "text-anchor": "middle" }, "LB"),
            h("text", { class: "wspad-sys", x: "454", y: "70", "text-anchor": "middle" }, "RB"),
            h("rect", { class: "wspad-shell", x: "110", y: "196", width: "98", height: "176", rx: "49", transform: "rotate(19 159 284)" }),
            h("rect", { class: "wspad-shell", x: "432", y: "196", width: "98", height: "176", rx: "49", transform: "rotate(-19 481 284)" }),
            h("rect", { class: "wspad-shell", x: "95", y: "85", width: "450", height: "176", rx: "74" }),
            h("circle", { class: "wspad-well", cx: "175", cy: "141", r: "40" }),
            h("path", { class: "wspad-zone", d: "M175 93 l9 13 h-18 z" }),
            h("path", { class: "wspad-zone", d: "M175 189 l9 -13 h-18 z" }),
            h("path", { class: "wspad-zone", d: "M127 141 l13 -9 v18 z" }),
            h("path", { class: "wspad-zone", d: "M223 141 l-13 -9 v18 z" }),
            h("circle", { class: "wspad-stick", cx: "175", cy: "141", r: "25" }),
            h("circle", { class: "wspad-well", cx: "390", cy: "213", r: "40" }),
            h("path", { class: "wspad-zone", d: "M390 165 l9 13 h-18 z" }),
            h("path", { class: "wspad-zone", d: "M390 261 l9 -13 h-18 z" }),
            h("path", { class: "wspad-zone", d: "M342 213 l13 -9 v18 z" }),
            h("path", { class: "wspad-zone", d: "M438 213 l-13 -9 v18 z" }),
            h("circle", { class: "wspad-stick", cx: "390", cy: "213", r: "25" }),
            h("rect", { class: "wspad-zone", x: "244", y: "177", width: "24", height: "30", rx: "6" }),
            h("rect", { class: "wspad-zone", x: "244", y: "223", width: "24", height: "30", rx: "6" }),
            h("rect", { class: "wspad-zone", x: "211", y: "203", width: "30", height: "24", rx: "6" }),
            h("rect", { class: "wspad-zone", x: "271", y: "203", width: "30", height: "24", rx: "6" }),
            h("circle", { class: "wspad-well", cx: "256", cy: "215", r: "9" }),
            h("circle", { class: "wspad-zone", cx: "465", cy: "106", r: "20" }),
            h("circle", { class: "wspad-zone", cx: "501", cy: "142", r: "20" }),
            h("circle", { class: "wspad-zone", cx: "465", cy: "178", r: "20" }),
            h("circle", { class: "wspad-zone", cx: "429", cy: "142", r: "20" }),
            h("text", { class: "wspad-face", x: "465", y: "111", "text-anchor": "middle" }, "Y"),
            h("text", { class: "wspad-face", x: "501", y: "147", "text-anchor": "middle" }, "B"),
            h("text", { class: "wspad-face", x: "465", y: "183", "text-anchor": "middle" }, "A"),
            h("text", { class: "wspad-face", x: "429", y: "147", "text-anchor": "middle" }, "X"),
            h("rect", { class: "wspad-zone", x: "286", y: "132", width: "26", height: "18", rx: "7" }),
            h("rect", { class: "wspad-zone", x: "328", y: "132", width: "26", height: "18", rx: "7" }),
            h("circle", { class: "wspad-well", cx: "320", cy: "103", r: "17" }),
            h("circle", { class: "wspad-guide", cx: "320", cy: "103", r: "7" }),
            h("text", { class: "wspad-sys", x: "299", y: "168", "text-anchor": "middle" }, "VIEW"),
            h("text", { class: "wspad-sys", x: "341", y: "168", "text-anchor": "middle" }, "MENU"),
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
        h("a", { class: "wsempty", href: "/map" }, "Edit button mappings in Controls"),
      ),
    ),
  );
}
