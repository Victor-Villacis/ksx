import { h, createSignal, createShow } from "@getforma/core";

// ── /workspace — THE WORKSPACE SHELL (M0 skeleton) ─────────────────────────
//
// The destination: one three-pane screen — keyboard + player rack on the
// left, the controller and keyboard diagrams in the center, the binding list
// on the right — absorbing what /start, /map and / do today. This file is the
// FRAME of that screen, landed first so the route, the seam, the payload and
// every gate (slot contract, parity, visual smoke) exist before any pane
// grows real controls. The panes render honest placeholder content and say
// where the working surfaces are; nothing here pretends to be finished.
//
// Two rules this page is built under, both inherited (see render.rs and
// docs/SURFACES.md §1):
//
// - **Every sentence is composed in Rust.** The payload's `view` field
//   (`WorkspaceDerived`, snapshot.rs) carries every displayed string and
//   every `show:` boolean; this island copies fields and derives nothing, so
//   the SSR paint and the 2 s poll cannot disagree.
// - **Signals live HERE**, never in WorkspacePage.ts or workspace.ts (the
//   twin-declaration trap — docs/FORMA-DOGFOOD.md #9), and every workspace
//   signal carries a `ws` prefix so the page this grows into can hold many
//   panes' slots without collisions.
//
// Compiler constraints honored below (see render.rs):
// - dynamic text/attrs must be bare `() => signalName()` calls;
// - createShow conditions must be bare `() => signalName()` too;
// - createShows are SIBLINGS, never nested.

// ── Wire types ─────────────────────────────────────────────────────────────

/** Every displayed string and every `show:` branch, computed once, in Rust
 *  (`WorkspaceDerived` in snapshot.rs). This island reads nothing else. */
export interface WorkspaceDerived {
  state_detail: string;
  device_line: string;
  rack_line: string;
  pill_running: boolean;
  pill_idle: boolean;
  pill_down: boolean;
}

/** What `GET /api/workspace` serves and what this island's payload block
 *  carries — one shape (`WorkspacePayload` in snapshot.rs), parity pinned in
 *  render_workspace.rs. `staged` and `session` are the raw provider reads;
 *  M0 renders only the derived view, so they stay untyped here until a pane
 *  needs their fields. */
export interface WorkspacePayload {
  staged: unknown;
  session: unknown;
  view: WorkspaceDerived;
}

// ── Signals — this list IS the FMIR slot table ─────────────────────────────

const [wsStateDetail, setWsStateDetail] = createSignal("");
const [wsDeviceLine, setWsDeviceLine] = createSignal("");
const [wsRackLine, setWsRackLine] = createSignal("");

const [wsPillRunning, setWsPillRunning] = createSignal(false);
const [wsPillIdle, setWsPillIdle] = createSignal(false);
const [wsPillDown, setWsPillDown] = createSignal(false);

// ── Appliers — copiers, never derivers ─────────────────────────────────────

export function applyWorkspace(p: WorkspacePayload): void {
  setWsStateDetail(p.view.state_detail);
  setWsDeviceLine(p.view.device_line);
  setWsRackLine(p.view.rack_line);
  setWsPillRunning(p.view.pill_running);
  setWsPillIdle(p.view.pill_idle);
  setWsPillDown(p.view.pill_down);
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
    h(
      "main",
      { class: "wsmain" },
      h(
        "aside",
        { class: "wspane" },
        h("h2", { class: "wskicker" }, "Keyboard"),
        h("p", { class: "wsline" }, () => wsDeviceLine()),
        h("h2", { class: "wskicker" }, "Virtual controllers"),
        h("p", { class: "wsline" }, () => wsRackLine()),
        h("a", { class: "wsempty", href: "/start" }, "Build or change this draft in guided setup"),
      ),
      h(
        "section",
        { class: "wsstage-col" },
        h(
          "div",
          { class: "wsstage" },
          h("p", { class: "wsstate" }, () => wsStateDetail()),
          h(
            "p",
            { class: "wsnote" },
            "The workspace is being built here — one screen for the keyboard, the controllers and the bindings. Until it lands, the pages in the Tools menu remain the working surfaces.",
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
