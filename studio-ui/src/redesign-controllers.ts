// The controller workbench: one canvas card per STAGED SLOT, mounted and
// retired to match the served payload. Unlike the device bench (browser
// arrangement state), the controller cards are DAEMON truth — the staged
// rack IS the list, so the server decides which cards exist and this module
// only reconciles the canvas to it. Positions stay the browser's (the
// arrangement store), like every widget.
//
// Slot order is the play order: at session start the daemon plugs pads in
// this order, and Windows hands each XInput pad the lowest FREE user index
// at that moment — so card order is what "P1" means, while the actual
// P-light is discovered at Play (ViGEm's callback; ksx-core/slot.rs).
//
// Widgets are client-created (data-client-widget — parity rule 3e).

import { createCanvasItem, WidgetCanvas } from "./genui/canvas/index";

/** One staged controller — `RedesignControllerCard` on the wire
 *  (snapshot.rs). Every sentence and both precomposed reorder strings are
 *  the server's; this module words nothing. */
export interface RdControllerCardView {
  number: string;
  persona: string;
  persona_label: string;
  preset: string;
  api_line: string;
  up_order: string;
  down_order: string;
}

interface CardGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

/** What the island lends this module — the engine, the tree, and the
 *  arrangement store, without this file owning any of them. */
export interface ControllerBenchIo {
  canvas: WidgetCanvas;
  root: HTMLElement;
  savedGeometry(id: string): CardGeometry | undefined;
  /** Called once after any mount/retire, so the island can refresh the map
   *  count and the chips. */
  onMutation(): void;
}

export function controllerInstanceId(number: string): string {
  return `ctrl-slot-${number}`;
}

const PERSONA_BADGE_FALLBACK = "Controller";

function verbForm(
  kind: "controller-move" | "controller-remove",
  action: string,
  field: string,
  value: string,
  label: string,
  title: string,
  danger: boolean,
): HTMLElement {
  const form = document.createElement("form");
  form.className = "rd-ctrlverb-form";
  form.method = "post";
  form.action = action;
  form.dataset.rdForm = kind;
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = field;
  hidden.value = value;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = danger ? "rd-ctrlverb rd-ctrlverb-danger" : "rd-ctrlverb";
  button.textContent = label;
  button.title = title;
  form.append(hidden, button);
  return form;
}

/** A reorder control with nowhere to go renders disabled with the honest
 *  reason, rather than posting the empty order the server would refuse to
 *  write anyway. */
function inertVerb(label: string, title: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rd-ctrlverb";
  button.disabled = true;
  button.textContent = label;
  button.title = title;
  return button;
}

function cardContent(card: RdControllerCardView): HTMLElement {
  const body = document.createElement("div");
  body.className = "rd-ctrlcard";
  const slot = document.createElement("p");
  slot.className = "rd-ctrlcard-slot";
  slot.textContent = `Slot ${card.number}`;
  slot.title =
    "The staged order. Pads plug in this order at Play, so with no real " +
    "pad holding an XInput slot, slot 1 is P1.";
  const badge = document.createElement("p");
  badge.className = "rd-ctrlcard-badge";
  badge.dataset.persona = card.persona;
  badge.textContent = card.persona_label || PERSONA_BADGE_FALLBACK;
  const name = document.createElement("p");
  name.className = "rd-ctrlcard-name";
  name.textContent = card.preset;
  const meta = document.createElement("p");
  meta.className = "rd-ctrlcard-meta";
  meta.textContent = card.api_line;
  const verbs = document.createElement("div");
  verbs.className = "rd-ctrlcard-verbs";
  verbs.append(
    card.up_order
      ? verbForm(
          "controller-move",
          "/redesign/controller/move",
          "order",
          card.up_order,
          "▲",
          "Move up — the earlier position plugs first at Play",
          false,
        )
      : inertVerb("▲", "Already first"),
    card.down_order
      ? verbForm(
          "controller-move",
          "/redesign/controller/move",
          "order",
          card.down_order,
          "▼",
          "Move down — the later position plugs later at Play",
          false,
        )
      : inertVerb("▼", "Already last"),
    verbForm(
      "controller-remove",
      "/redesign/controller/remove",
      "number",
      card.number,
      "✕",
      "Remove this controller from the draft. Nothing is saved or started.",
      true,
    ),
  );
  body.append(slot, badge, name, meta, verbs);
  return body;
}

/** Reconcile the canvas to the served card list: mount what the daemon
 *  staged, retire what it dropped, and rebuild the face of what changed
 *  (the keyed identity is the slot NUMBER — the daemon renumbers on
 *  reorder, so a renumbered slot is a different card and re-mounts; its
 *  position follows the arrangement store's memory for that number). */
export function syncControllerWidgets(
  cards: RdControllerCardView[],
  io: ControllerBenchIo,
): void {
  const wanted = new Map(cards.map((card) => [controllerInstanceId(card.number), card]));
  let changed = false;
  for (const item of Array.from(
    io.root.querySelectorAll<HTMLElement>(
      '.forma-canvas-stage > [data-instance-id^="ctrl-slot-"]',
    ),
  )) {
    const id = item.dataset.instanceId ?? "";
    const card = wanted.get(id);
    if (!card) {
      io.canvas.removeItem(item, { selectFallback: false });
      changed = true;
      continue;
    }
    // Same slot number: refresh the face in place (persona, preset and the
    // precomposed orders all may have changed under it).
    item.querySelector(".rd-ctrlcard")?.replaceWith(cardContent(card));
    wanted.delete(id);
  }
  let index = cards.length - wanted.size;
  for (const [id, card] of wanted) {
    const item = createCanvasItem({
      instanceId: id,
      displayName: `Slot ${card.number} — ${card.preset}`,
      preferredWidth: 300,
      minHeight: 190,
      content: cardContent(card),
      document,
    });
    item.dataset.clientWidget = "";
    item.classList.add("rd-ctrl-node");
    const home: CardGeometry = {
      x: 140 + (index % 3) * 340,
      y: 430 + Math.floor(index / 3) * 230,
      width: 300,
      height: 190,
      z: 20 + index,
      manualScale: 1,
    };
    io.canvas.mountItem(item, io.savedGeometry(id) ?? home, { focus: false });
    changed = true;
    index += 1;
  }
  if (changed) io.onMutation();
}
