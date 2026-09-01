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
import {
  applyDs4Variant,
  applyPremiumControllerVariant,
  controllerFinishFor,
  ds4VariantFor,
  premiumControllerConfig,
  type PremiumControllerFamily,
} from "./padFinishes";
import { DS4_PREMIUM_VARIANTS } from "./ds4PremiumGeometry";
import { composeOrderMoving } from "./redesign-controller-order";

/** One staged pad's canvas dressing — `NocturnePadView` on the wire
 *  (snapshot.rs), the same rows /nocturne's widgets clone and dress. Only
 *  the fields this workbench draws are named; the rest ride along. */
export interface RdPadControlView {
  function: string;
  label: string;
  group: string;
  order: number;
  keys: string[];
  toggle: boolean;
  turbo_hz: number | null;
}

export interface RdPadMacroView {
  name: string;
  triggers: string[];
  outputs: { function: string; steps: number[] }[];
  timeline: string[];
  meta: string;
  disabled: boolean;
  edit_href: string;
}

/** One exact physical keyboard's route into this controller. Routed and
 * synthetic (eligible first-bind) rows share the same revision contract. */
export interface RdPadSourceView {
  source_id: string;
  source_alias: string;
  source_label?: string;
  routed: boolean;
  revision: string;
  preset: string;
  fn_keys: Record<string, string>;
  fn_names?: Record<string, string>;
  controls?: RdPadControlView[];
  mapping_available: boolean;
  mapping_reason: string;
  macros?: RdPadMacroView[];
  macro_available?: boolean;
  macro_reason?: string;
}

export interface RdPadView {
  slot: number;
  family: string;
  preset: string;
  title: string;
  /** Opaque staged-controller revision served with this exact row — the
   *  mapper's target pin. Returned unchanged with a bind; never
   *  reconstructed from the visible preset/persona. */
  target_revision?: string;
  /** Canonical fn → its key chip ("G · H"), for the clone's callouts. */
  fn_keys: Record<string, string>;
  /** Canonical fn → the persona's readable label ("LS ↑", "△") — the
   *  toast's vocabulary for arming ANY pad's control. */
  fn_names: Record<string, string>;
  /** Every controller control in one stable authoring order, exact key
   *  vectors included — the auto-map walk's queue and the cords' graph. */
  controls?: RdPadControlView[];
  /** Timed processors owned by this preset — the cords draw these as real
   *  key → macro → control chains. */
  macros?: RdPadMacroView[];
  /** `false` means the provider could not project this slot's mapper table
   *  — an empty `fn_keys` is otherwise the valid fact "nothing is bound". */
  mapping_available: boolean;
  mapping_reason: string;
  macro_available?: boolean;
  macro_reason?: string;
  /** Canonical multi-keyboard projection. Present (including empty) replaces
   * the compatibility table above for source-qualified authoring and cords. */
  sources?: RdPadSourceView[];
}

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

export interface CardGeometry {
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
  /** The served pad dressing rows, keyed to the cards by slot number. */
  pads: RdPadView[];
  /** Exact keyboard whose mappings the controller art is currently editing.
   * Nested `pad.sources` is canonical; the pad-level fields are only the
   * historical first-source projection and must not dress another source's
   * card while this value is present. */
  authoringSource: string;
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
  /** Assign a collision-free home and current stack position to a widget
   *  that has no saved user geometry. */
  allocateFreshGeometry(geometry: CardGeometry): CardGeometry;
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

/** The unknown-family placeholder — nocturne's wording verbatim: a NAMED
 *  outcome, never a wrong silhouette. */
function unrecognisedPadBody(family: string): HTMLElement {
  const body = document.createElement("p");
  body.className = "n-mini-unknown rd-ctrlcard-noart";
  body.setAttribute("role", "status");
  body.textContent = "No controller art for this device" +
    (family && family !== "unknown" ? ` ("${family}")` : "") +
    ". Its buttons still bind — update ksx Studio to see it drawn.";
  return body;
}

/** The callout chip's compression — nocturne's `calloutText`, with the
 *  identity cap map: this page has no board picture yet, so key names are
 *  spoken as the mapper spells them. */
function calloutText(chip: string): string {
  let text = chip.split(" · ").join("·");
  if (text.length > 9) text = text.slice(0, 8) + "…";
  return text;
}

/** A widget's durable identity for the FINISH stores: the controller is its
 *  PRESET (nocturne's `padStoreKeys` rule — twin seats on one preset get
 *  #2/#3… suffixes in slot order, or both twins fight over one saved
 *  finish). */
function finishStoreKeys(cards: readonly RdControllerCardView[]): Map<string, string> {
  const seen = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const card of cards) {
    const n = (seen.get(card.preset) ?? 0) + 1;
    seen.set(card.preset, n);
    keys.set(card.number, "p:" + card.preset + (n > 1 ? "#" + n : ""));
  }
  return keys;
}

function liveCardFingerprint(
  card: RdControllerCardView,
  allNumbers: readonly string[],
  pad: RdPadView | undefined,
  storeKey: string,
): string {
  return JSON.stringify(["live", card, allNumbers, pad ?? null, storeKey]);
}

/** Resolve the controller card's visual/edit vocabulary from the exact same
 * physical source as the inspector. `pad.sources` is the canonical
 * many-keyboard projection; the top-level fields remain a compatibility seam
 * only for older payloads that do not serve that array.
 *
 * A nonempty source that is absent from a canonical array fails closed. A
 * stale URL or provider mismatch must show no borrowed callouts and an honest
 * refusal, never silently repaint the first keyboard's mappings. */
function padForAuthoringSource(pad: RdPadView, requestedSource: string): RdPadView {
  if (pad.sources === undefined) return pad;
  const requested = requestedSource.trim();
  const source = requested
    ? pad.sources.find((candidate) => candidate.source_id === requested)
    : pad.sources[0];
  if (!source) {
    return {
      ...pad,
      fn_keys: {},
      controls: [],
      macros: [],
      mapping_available: false,
      mapping_reason: requested
        ? "The selected input is no longer available for this controller. Refresh the workbench or choose another exact source."
        : "Choose an input source before editing this controller.",
      macro_available: false,
      macro_reason: "Choose an available input source before editing macros.",
    };
  }
  return {
    ...pad,
    fn_keys: source.fn_keys ?? {},
    fn_names: source.fn_names ?? pad.fn_names,
    controls: source.controls,
    macros: source.macros,
    mapping_available: source.mapping_available,
    mapping_reason: source.mapping_reason,
    macro_available: source.macro_available,
    macro_reason: source.macro_reason,
  };
}

function ghostCardFingerprint(
  parked: ParkedController,
  livePositions: number,
  io: ControllerBenchIo,
): string {
  return JSON.stringify([
    "ghost",
    parked,
    livePositions,
    io.parkedHeld.has(parked.id),
    io.addPreset,
    io.addLayout,
  ]);
}

/** A payload may legitimately change while a card-owned control has focus.
 * Preserve that logical control across the necessary replacement; unchanged
 * two-second polls skip replacement entirely. */
function cardFocusSelector(card: HTMLElement): string | null {
  const active = document.activeElement;
  if (!(active instanceof Element) || !card.contains(active)) return null;
  const padControl = active.closest<Element>("[data-rd-pad-action][data-fn]");
  if (padControl) {
    const fn = padControl.getAttribute("data-fn");
    if (fn) return `[data-rd-pad-action][data-fn="${CSS.escape(fn)}"]`;
  }
  if (active instanceof HTMLElement) {
    if (active.dataset.ds4Variant) {
      return `[data-ds4-variant="${CSS.escape(active.dataset.ds4Variant)}"]`;
    }
    if (active.dataset.controllerVariant) {
      return `[data-controller-variant="${CSS.escape(active.dataset.controllerVariant)}"]`;
    }
    if (active.matches(".rd-ctrlplayer")) return ".rd-ctrlplayer";
    const nx = active.dataset.nx;
    if (nx) return `[data-nx="${CSS.escape(nx)}"]`;
    if (active.matches(".rd-ctrlverb-danger")) return ".rd-ctrlverb-danger";
  }
  return null;
}

function restoreCardFocus(card: HTMLElement, selector: string | null): void {
  if (!selector) return;
  const target = card.querySelector<Element>(selector);
  if (target && "focus" in target && typeof (target as HTMLElement).focus === "function") {
    (target as HTMLElement).focus({ preventScroll: true });
  }
}

/** The REAL body — a CLONE of the shared hidden master for the served
 *  family (the nocturne widget's exact mechanism: `pv.family` is READ,
 *  never re-decided; a family with no master is a visible failure), dressed
 *  with the slot's own fn→keys callouts and the saved DS4/premium finish.
 *  `swatches` (when the family has variants) mounts into the card so the
 *  finish is choosable right on the workbench, exactly like 4460. */
function padBody(
  io: ControllerBenchIo,
  family: string,
  personaLabel: string,
  fnKeys: Record<string, string> | null,
  controls: RdPadView["controls"],
  storeKey: string,
): { art: HTMLElement; swatches: HTMLElement | null } {
  const master = io.root.querySelector<HTMLElement>(
    `.n-padmasters .n-padwrap[data-pad-family="${CSS.escape(family)}"]`,
  );
  const source = master?.querySelector(".ps5a") ?? master?.querySelector("svg");
  if (!source) return { art: unrecognisedPadBody(family), swatches: null };
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.classList.add("rd-ctrlcard-art");
  // The vendored masters are hidden templates. Their clones are visible,
  // interactive controller groups, so template-only accessibility state must
  // not survive onto the canvas copy.
  clone.removeAttribute("aria-hidden");
  clone.removeAttribute("focusable");
  clone.setAttribute("role", "group");
  clone.setAttribute("aria-label", personaLabel || PERSONA_BADGE_FALLBACK);
  // Dress the callouts from THIS slot's own served table (empty for a
  // ghost, whose slot left the daemon).
  const byFn = new Map<string, string>();
  for (const [fnName, keys] of Object.entries(fnKeys ?? {})) {
    byFn.set(fnName.toLowerCase(), keys);
  }
  for (const el of Array.from(clone.querySelectorAll<SVGTextElement>("text.n-fnkey"))) {
    const fns = (el.getAttribute("data-fn") ?? "").split(/\s+/);
    const parts: string[] = [];
    for (const fnName of fns) {
      const keys = byFn.get(fnName.toLowerCase());
      if (keys) parts.push(calloutText(keys));
    }
    el.textContent = parts.join("·");
  }
  // The transparent SVG hooks are real direct-manipulation controls, not
  // decorative hit regions. Expose one focus stop for each canonical
  // function (some premium drawings carry duplicate paint variants), name it
  // from the served controller vocabulary, and make Enter/Space take the
  // exact same bubbling click path as a pointer.
  const labels = new Map(
    (controls ?? []).map((control) => [control.function.toLowerCase(), control.label]),
  );
  const focusableFns = new Set<string>();
  const padZones = Array.from(
    clone.querySelectorAll<SVGElement>("[data-fn]:not(.n-fnkey)"),
  );
  // Parked cards deliberately have no served control table or player slot.
  // Their drawing is a visual identity only until re-slotted; leaving the
  // old data-fn hooks in place could route a click to the last live panel.
  if (controls === undefined) {
    for (const el of Array.from(clone.querySelectorAll<SVGElement>("[data-fn]"))) {
      el.removeAttribute("data-fn");
    }
  }
  for (const el of controls === undefined ? [] : padZones) {
    const fnName = (el.getAttribute("data-fn") ?? "").split(/\s+/)[0]?.trim() ?? "";
    const key = fnName.toLowerCase();
    if (!fnName || focusableFns.has(key)) continue;
    focusableFns.add(key);
    const label = labels.get(key) || fnName;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", `${label} controller control`);
    el.setAttribute("data-rd-pad-action", "");
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      el.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      }));
    });
  }
  // The finish swatches — the nocturne widget's DS4-variant / premium
  // machinery, off the SHARED padFinishes module and stores.
  let swatches: HTMLElement | null = null;
  if (family === "ps" && clone.matches("svg.ds4premium")) {
    const controls = document.createElement("div");
    controls.className = "n-ds4-variants";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "DualShock 4 color");
    for (const variant of DS4_PREMIUM_VARIANTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "n-ds4-variant";
      button.dataset.ds4Variant = variant.slug;
      button.setAttribute("aria-label", variant.label + " controller finish");
      button.setAttribute("aria-pressed", "false");
      button.title = variant.label;
      button.style.setProperty("--ds4-variant-swatch", variant.swatch);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        applyDs4Variant(clone, controls, storeKey, variant.slug, true);
      });
      controls.append(button);
    }
    // A swatch press must not begin a canvas drag before its click lands.
    controls.addEventListener("pointerdown", (event) => event.stopPropagation());
    applyDs4Variant(
      clone,
      controls,
      storeKey,
      ds4VariantFor(storeKey) ?? DS4_PREMIUM_VARIANTS[0].slug,
      false,
    );
    swatches = controls;
  } else {
    const config = premiumControllerConfig(family);
    if (config && clone.matches(config.selector)) {
      const premiumFamily = family as PremiumControllerFamily;
      const controls = document.createElement("div");
      controls.className = "n-controller-variants";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", config.label + " color");
      for (const variant of config.variants) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "n-controller-variant";
        button.dataset.controllerVariant = variant.slug;
        button.setAttribute("aria-label", variant.label + " controller finish");
        button.setAttribute("aria-pressed", "false");
        button.title = variant.label;
        button.style.setProperty("--controller-variant-swatch", variant.swatch);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          applyPremiumControllerVariant(
            clone,
            controls,
            premiumFamily,
            storeKey,
            variant.slug,
            true,
          );
        });
        controls.append(button);
      }
      controls.addEventListener("pointerdown", (event) => event.stopPropagation());
      applyPremiumControllerVariant(
        clone,
        controls,
        premiumFamily,
        storeKey,
        controllerFinishFor(premiumFamily, storeKey) ?? config.variants[0].slug,
        false,
      );
      swatches = controls;
    }
  }
  const art = document.createElement("div");
  art.className = "rd-ctrlcard-artwrap";
  art.append(clone);
  return { art, swatches };
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
  pad: RdPadView | undefined,
  storeKey: string,
): HTMLElement {
  const body = document.createElement("div");
  body.className = "rd-ctrlcard";
  body.dataset.renderFingerprint = liveCardFingerprint(card, allNumbers, pad, storeKey);
  // The ramp digit — every surface speaking for this slot wears np{n}
  // (the shared sheet's per-player tint vocabulary).
  body.classList.add(`np${card.number}`);
  body.setAttribute("data-pad-slot", card.number);
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
  const { art, swatches } = padBody(
    io,
    card.family,
    card.persona_label,
    pad?.fn_keys ?? null,
    pad?.controls,
    storeKey,
  );
  const head = [slot, ...badgeAndName(card.persona, card.persona_label, card.preset)];
  if (swatches) head.push(swatches);
  body.append(...head, art);
  // The provider's own refusal, when the mapper table could not be read —
  // an empty callout set is otherwise the valid fact "nothing is bound".
  if (pad && !pad.mapping_available && pad.mapping_reason) {
    const refusal = document.createElement("p");
    refusal.className = "rd-ctrlcard-meta rd-ctrlcard-refusal";
    refusal.textContent = pad.mapping_reason;
    body.append(refusal);
  }
  body.append(meta, verbs);
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
  body.dataset.renderFingerprint = ghostCardFingerprint(parked, livePositions, io);
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
  // A ghost's slot left the daemon, so its clone wears no callouts; the
  // finish still follows its preset identity.
  const { art, swatches } = padBody(
    io,
    parked.family || "unknown",
    parked.persona_label,
    null,
    undefined,
    "p:" + parked.preset,
  );
  const head = [slot, ...badgeAndName(parked.persona, parked.persona_label, parked.preset)];
  if (swatches) head.push(swatches);
  body.append(...head, art, meta, verbs);
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
    // The nocturne pad widget's width class (440): the real silhouettes are
    // wide drawings, and their callout text must stay legible.
    preferredWidth: 440,
    minHeight: 420,
    content,
    document,
  });
  item.dataset.clientWidget = "";
  item.classList.add("rd-ctrl-node");
  // The cords resolve pads via `.n-widget-pad [data-pad-slot]` (the
  // nocturne vocabulary) — the card item wears the class so ONE resolver
  // serves both pages. Ghosts deliberately do not: a parked slot has no
  // cords.
  if (!extraClass) item.classList.add("n-widget-pad");
  if (extraClass) item.classList.add(extraClass);
  const home: CardGeometry = {
    x: 140 + (index % 3) * 480,
    y: 430 + Math.floor(index / 3) * 520,
    width: 440,
    height: 420,
    z: 20 + index,
    manualScale: 1,
  };
  io.canvas.mountItem(
    item,
    io.savedGeometry(id) ?? io.allocateFreshGeometry(home),
    { focus: false },
  );
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
  const storeKeys = finishStoreKeys(cards);
  const padBySlot = new Map(
    io.pads.map((pad) => [
      String(pad.slot),
      padForAuthoringSource(pad, io.authoringSource),
    ]),
  );
  const dress = (card: RdControllerCardView): HTMLElement =>
    liveCardContent(
      card,
      allNumbers,
      io,
      padBySlot.get(card.number),
      storeKeys.get(card.number) ?? "p:" + card.preset,
    );
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
      const current = item.querySelector<HTMLElement>(".rd-ctrlcard");
      const pad = padBySlot.get(live.number);
      const storeKey = storeKeys.get(live.number) ?? "p:" + live.preset;
      const fingerprint = liveCardFingerprint(live, allNumbers, pad, storeKey);
      if (current?.dataset.renderFingerprint !== fingerprint) {
        const focusSelector = current ? cardFocusSelector(current) : null;
        const replacement = dress(live);
        current?.replaceWith(replacement);
        restoreCardFocus(replacement, focusSelector);
      }
      wantedLive.delete(id);
    } else if (ghost) {
      const current = item.querySelector<HTMLElement>(".rd-ctrlcard");
      const fingerprint = ghostCardFingerprint(ghost, cards.length, io);
      if (current?.dataset.renderFingerprint !== fingerprint) {
        const focusSelector = current ? cardFocusSelector(current) : null;
        const replacement = ghostCardContent(ghost, cards.length, io);
        current?.replaceWith(replacement);
        restoreCardFocus(replacement, focusSelector);
      }
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
      dress(card),
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
