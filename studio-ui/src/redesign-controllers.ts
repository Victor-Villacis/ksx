// The controller workbench: one canvas card per STAGED SLOT, mounted and
// retired to match the served payload, plus the PARKED ghosts — controllers
// taken off the draft ("No player") that wait on the canvas to be re-slotted.
//
// Live cards are DAEMON truth: the staged rack IS the list, so the server
// decides which live cards exist and this module only reconciles the canvas
// to it. Ghosts are browser arrangement state (the island's prefs), like the
// device bench. Positions stay the browser's either way.
//
// Player assignment is DIRECT, not spatial: every card wears a Player
// select (P1…Pn, or "No player"). Choosing a position posts ONE whole-order
// permutation to the existing move verb — the daemon renumbers, survivors
// keep arrival order, exactly the rack's algorithm. Choosing "No player"
// removes the slot (the daemon compacts the rest up) and parks the card as
// a ghost. Re-slotting a ghost stages it fresh at the chosen position (the
// entry chains add + move). Arrival numbering itself is the daemon's
// `next_slot`.
//
// Widgets are client-created (data-client-widget — parity rule 3e).

import { createCanvasItem, WidgetCanvas } from "./genui/canvas/index";
import { composeOrderMoving } from "./redesign-controller-order";

/** One staged controller — `RedesignControllerCard` on the wire
 *  (snapshot.rs). Every sentence is the server's; this module words only
 *  the assignment chrome. */
export interface RdControllerCardView {
  number: string;
  persona: string;
  persona_label: string;
  preset: string;
  api_line: string;
  /** The presentation family from the server's ONE total record — never
   *  re-decided here. `"unknown"` draws a named placeholder, not a wrong
   *  silhouette (the pad-presentation rule). */
  family: string;
  /** The vendored body drawing for that family, served beside it. */
  art: string;
}

/** One parked controller — browser state, held in the island's prefs. Its
 *  slot left the daemon when it was orphaned, so only the display facts
 *  survive; re-slotting stages it fresh. */
export interface ParkedController {
  id: string;
  persona: string;
  persona_label: string;
  preset: string;
  /** The served presentation captured at park time, so the ghost keeps the
   *  real body drawing. Older stored entries may lack them — an empty
   *  family draws the named placeholder. */
  family: string;
  art: string;
}

interface CardGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

/** What the island lends this module — the engine, the tree, the stores and
 *  the served add values, without this file owning any of them. */
export interface ControllerBenchIo {
  canvas: WidgetCanvas;
  root: HTMLElement;
  parked: ParkedController[];
  /** The ghost ids the SERVER still holds resurrection material for
   *  (`parked_held`, served) — decides each ghost's honest wording:
   *  bindings kept, or staged fresh after a daemon restart. */
  parkedHeld: Set<string>;
  /** The served values a ghost re-slot posts: `next_preset` (a future file
   *  name) and the default layout that makes a fresh slot playable. */
  addPreset: string;
  addLayout: string;
  savedGeometry(id: string): CardGeometry | undefined;
  /** Park one live card's display facts as a ghost (after its park verb
   *  submits — a re-sync before the submit would detach the form). */
  park(entry: ParkedController): void;
  /** Called once after any mount/retire, so the island can refresh the map
   *  count and the chips. */
  onMutation(): void;
}

export function controllerInstanceId(number: string): string {
  return `ctrl-slot-${number}`;
}

export function parkedInstanceId(id: string): string {
  return `ctrl-parked-${id}`;
}

const PERSONA_BADGE_FALLBACK = "Controller";
const ORPHAN_TITLE =
  "No player parks this controller off the draft — the others move up. The " +
  "studio keeps its bindings, and re-slotting brings them back.";

function playerSelect(
  positions: number,
  current: number | null,
  title: string,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "rd-ctrlplayer";
  select.title = title;
  select.setAttribute("aria-label", "Player position");
  for (let p = 1; p <= positions; p += 1) {
    const option = document.createElement("option");
    option.value = String(p);
    option.textContent = `Player ${p}`;
    if (current === p) option.selected = true;
    select.append(option);
  }
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No player";
  if (current === null) none.selected = true;
  select.append(none);
  return select;
}

function badgeAndName(
  persona: string,
  personaLabel: string,
  preset: string,
): HTMLElement[] {
  const badge = document.createElement("p");
  badge.className = "rd-ctrlcard-badge";
  badge.dataset.persona = persona;
  badge.textContent = personaLabel || PERSONA_BADGE_FALLBACK;
  const name = document.createElement("p");
  name.className = "rd-ctrlcard-name";
  name.textContent = preset;
  return [badge, name];
}

/** The REAL body drawing — the served vendored silhouette for the served
 *  family. An `"unknown"` family deliberately draws no body (the record's
 *  rule: a named placeholder, never a wrong silhouette); the badge above
 *  already names the persona, and the note says why there is no picture. */
function padArt(family: string, art: string, personaLabel: string): HTMLElement {
  if (family === "unknown" || !art) {
    const note = document.createElement("p");
    note.className = "rd-ctrlcard-meta rd-ctrlcard-noart";
    note.textContent =
      "This build does not recognise the persona, so it draws no body rather " +
      "than the wrong one.";
    return note;
  }
  const img = document.createElement("img");
  img.className = "rd-ctrlcard-art";
  img.src = art;
  img.alt = personaLabel || PERSONA_BADGE_FALLBACK;
  // The art is the widget's face, never a drag/select target of its own —
  // and never the browser's native image drag.
  img.draggable = false;
  return img;
}

function removeForm(number: string): HTMLElement {
  const form = document.createElement("form");
  form.className = "rd-ctrlverb-form";
  form.method = "post";
  form.action = "/redesign/controller/remove";
  form.dataset.rdForm = "controller-remove";
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = "number";
  hidden.value = number;
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "rd-ctrlverb rd-ctrlverb-danger";
  button.textContent = "✕";
  button.title = "Remove this controller from the draft. Nothing is saved or started.";
  form.append(hidden, button);
  return form;
}

/** A LIVE card: slot chip, persona, preset, the api line, and the verbs —
 *  the Player select (direct assignment; "No player" parks) plus remove. */
function liveCardContent(
  card: RdControllerCardView,
  allNumbers: string[],
  io: ControllerBenchIo,
): HTMLElement {
  const body = document.createElement("div");
  body.className = "rd-ctrlcard";
  const slot = document.createElement("p");
  slot.className = "rd-ctrlcard-slot";
  slot.textContent = `Slot ${card.number}`;
  slot.title =
    "The staged order. Pads plug in this order at Play, so with no real " +
    "pad holding an XInput slot, slot 1 is P1.";
  const meta = document.createElement("p");
  meta.className = "rd-ctrlcard-meta";
  meta.textContent = card.api_line;

  // The hidden move form the select drives: ONE whole-order write per
  // change, through the existing typed wiring.
  const moveForm = document.createElement("form");
  moveForm.className = "rd-ctrlverb-form";
  moveForm.method = "post";
  moveForm.action = "/redesign/controller/move";
  moveForm.dataset.rdForm = "controller-move";
  const order = document.createElement("input");
  order.type = "hidden";
  order.name = "order";
  moveForm.append(order);

  // The hidden park form: ONE server transaction stashes the slot's
  // resurrection material under this ghost id, removes it, and compacts
  // the survivors. The id is minted at render so the form and the prefs
  // entry agree.
  const ghostId = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const parkForm = document.createElement("form");
  parkForm.className = "rd-ctrlverb-form";
  parkForm.method = "post";
  parkForm.action = "/redesign/controller/park";
  parkForm.dataset.rdForm = "controller-park";
  for (const [name, value] of [
    ["number", card.number],
    ["ghost", ghostId],
  ]) {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = name;
    hidden.value = value;
    parkForm.append(hidden);
  }

  const position = allNumbers.indexOf(card.number) + 1;
  const select = playerSelect(
    allNumbers.length,
    position > 0 ? position : null,
    "While configuring, a controller's player position is freely " +
      "reassignable — the others shuffle around it in arrival order. " +
      ORPHAN_TITLE,
  );
  select.addEventListener("change", () => {
    if (select.value === "") {
      // Submit FIRST, park second — both in this one synchronous task, so
      // the ghost still appears before any network settles. The other order
      // is a trap: park() re-syncs the canvas immediately, which REPLACES
      // this card's content, and a submit dispatched on a detached form
      // bubbles to nobody — the verb silently never posts.
      parkForm.requestSubmit();
      io.park({
        id: ghostId,
        persona: card.persona,
        persona_label: card.persona_label,
        preset: card.preset,
        family: card.family,
        art: card.art,
      });
      return;
    }
    order.value = composeOrderMoving(allNumbers, card.number, Number(select.value));
    moveForm.requestSubmit();
  });

  const verbs = document.createElement("div");
  verbs.className = "rd-ctrlcard-verbs";
  verbs.append(select, moveForm, parkForm, removeForm(card.number));
  body.dataset.family = card.family;
  body.append(
    slot,
    ...badgeAndName(card.persona, card.persona_label, card.preset),
    padArt(card.family, card.art, card.persona_label),
    meta,
    verbs,
  );
  return body;
}

/** A PARKED ghost: no slot, no player — a select to re-slot it (one server
 *  transaction: restore-or-fresh, then seat), and ✕ to discard the ghost
 *  (browser-only). The wording tells the truth the server serves: while the
 *  studio holds the parked slot, re-slotting brings its bindings back; after
 *  a daemon restart it stages fresh. */
function ghostCardContent(
  parked: ParkedController,
  livePositions: number,
  io: ControllerBenchIo,
): HTMLElement {
  const held = io.parkedHeld.has(parked.id);
  const body = document.createElement("div");
  body.className = "rd-ctrlcard rd-ctrlcard-ghost";
  const slot = document.createElement("p");
  slot.className = "rd-ctrlcard-slot rd-ctrlcard-noplayer";
  slot.textContent = "No player";
  slot.title = ORPHAN_TITLE;
  const meta = document.createElement("p");
  meta.className = "rd-ctrlcard-meta";
  meta.textContent = held
    ? "Parked — bindings kept until re-slotted."
    : "Parked before a daemon restart — re-slotting stages it fresh on the default layout.";

  const assignForm = document.createElement("form");
  assignForm.className = "rd-ctrlverb-form";
  assignForm.method = "post";
  assignForm.action = "/redesign/controller/assign";
  assignForm.dataset.rdForm = "controller-assign";
  for (const [name, value] of [
    ["persona", parked.persona],
    ["preset", io.addPreset],
    ["layout", io.addLayout],
    ["ghost", parked.id],
    ["position", ""],
  ]) {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = name;
    hidden.value = value;
    assignForm.append(hidden);
  }
  const select = playerSelect(
    livePositions + 1,
    null,
    held
      ? "Re-slot this controller at the chosen position — its bindings come " +
        "back with it, and the others bump down in arrival order."
      : "Re-slot this controller: it is staged fresh at the chosen position " +
        "and the others bump down in arrival order.",
  );
  select.addEventListener("change", () => {
    if (select.value === "") return;
    assignForm.querySelector<HTMLInputElement>('input[name="position"]')!.value =
      select.value;
    assignForm.requestSubmit();
  });

  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "rd-ctrlverb rd-ctrlverb-danger";
  discard.dataset.nx = "rd-ctrl-discard";
  discard.dataset.ghost = parked.id;
  discard.textContent = "✕";
  discard.title = "Discard this parked controller. Nothing on the daemon changes.";

  const verbs = document.createElement("div");
  verbs.className = "rd-ctrlcard-verbs";
  verbs.append(select, assignForm, discard);
  body.dataset.family = parked.family || "unknown";
  body.append(
    slot,
    ...badgeAndName(parked.persona, parked.persona_label, parked.preset),
    padArt(parked.family, parked.art, parked.persona_label),
    meta,
    verbs,
  );
  return body;
}

function mountCard(
  io: ControllerBenchIo,
  id: string,
  displayName: string,
  content: HTMLElement,
  extraClass: string,
  index: number,
): void {
  const item = createCanvasItem({
    instanceId: id,
    displayName,
    preferredWidth: 320,
    minHeight: 380,
    content,
    document,
  });
  item.dataset.clientWidget = "";
  item.classList.add("rd-ctrl-node");
  if (extraClass) item.classList.add(extraClass);
  const home: CardGeometry = {
    x: 140 + (index % 3) * 360,
    y: 430 + Math.floor(index / 3) * 430,
    width: 320,
    height: 380,
    z: 20 + index,
    manualScale: 1,
  };
  io.canvas.mountItem(item, io.savedGeometry(id) ?? home, { focus: false });
}

/** Reconcile the canvas to the served card list AND the parked ghosts:
 *  mount what the daemon staged (keyed by slot number — the daemon
 *  renumbers on reorder, so a renumbered slot re-mounts and follows the
 *  arrangement store's memory for that number), retire what it dropped,
 *  and keep one ghost per parked entry. */
export function syncControllerWidgets(
  cards: RdControllerCardView[],
  io: ControllerBenchIo,
): void {
  const allNumbers = cards.map((card) => card.number);
  const wantedLive = new Map(
    cards.map((card) => [controllerInstanceId(card.number), card]),
  );
  const wantedGhosts = new Map(
    io.parked.map((entry) => [parkedInstanceId(entry.id), entry]),
  );
  let changed = false;
  for (const item of Array.from(
    io.root.querySelectorAll<HTMLElement>(
      '.forma-canvas-stage > [data-instance-id^="ctrl-slot-"], ' +
        '.forma-canvas-stage > [data-instance-id^="ctrl-parked-"]',
    ),
  )) {
    const id = item.dataset.instanceId ?? "";
    const live = wantedLive.get(id);
    const ghost = wantedGhosts.get(id);
    if (live) {
      item.querySelector(".rd-ctrlcard")?.replaceWith(liveCardContent(live, allNumbers, io));
      wantedLive.delete(id);
    } else if (ghost) {
      item
        .querySelector(".rd-ctrlcard")
        ?.replaceWith(ghostCardContent(ghost, cards.length, io));
      wantedGhosts.delete(id);
    } else {
      io.canvas.removeItem(item, { selectFallback: false });
      changed = true;
    }
  }
  let index = cards.length + io.parked.length - wantedLive.size - wantedGhosts.size;
  for (const [id, card] of wantedLive) {
    mountCard(
      io,
      id,
      `Slot ${card.number} — ${card.preset}`,
      liveCardContent(card, allNumbers, io),
      "",
      index,
    );
    changed = true;
    index += 1;
  }
  for (const [id, entry] of wantedGhosts) {
    mountCard(
      io,
      id,
      `No player — ${entry.preset}`,
      ghostCardContent(entry, cards.length, io),
      "rd-ctrl-ghost",
      index,
    );
    changed = true;
    index += 1;
  }
  if (changed) io.onMutation();
}
