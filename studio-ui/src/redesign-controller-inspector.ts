// The selected controller's inspector panel — /nocturne's right-pane
// controller sections (the meta strip, the six bind groups with their
// free-control chips and counts, the SOCD editor, the row editors), rebuilt
// from the SAME served `ControllerPanel` struct that page renders, with the
// same class vocabulary so the shared sheet dresses both.
//
// This page's inspector body is client-painted (renderInspector's own
// pattern), so these sections are DOM builders, not island markup. Every
// mutating control is a REAL form posting this page's re-homed verb; the
// entry's typed fetch-submit layer upgrades them exactly like the card
// verbs; the learn/assign chips are LIVE buttons the island's dispatch
// arms through the shared mapper (redesign-mapper.ts).

/** One bind row — `NocturneBindRow` on the wire (snapshot.rs). */
export interface RdBindRowView {
  function: string;
  label: string;
  chip: string;
  note: string;
  cls: string;
  chip_cls: string;
  minus_cls: string;
  clear_cls: string;
  slot: string;
  turbo: string;
  chip_title: string;
  badge: string;
  badge_cls: string;
  add_cls: string;
  hold_cls: string;
  tog_cls: string;
}

/** One free-control chip — `NocturneCtlChip` on the wire. */
export interface RdCtlChipView {
  function: string;
  label: string;
  cls: string;
}

/** One select option — `NocturneOptionRow` on the wire. */
export interface RdOptionView {
  value: string;
  label: string;
}

/** The whole panel — `ControllerPanel` on the wire (snapshot.rs), the same
 *  struct `/nocturne`'s right pane destructures. */
export interface RdPanelView {
  slot_val: string;
  pad_badge: string;
  pad_badge_cls: string;
  pad_name: string;
  pad_sub: string;
  bind_title: string;
  bind_foot: string;
  bind_face: RdBindRowView[];
  bind_dpad: RdBindRowView[];
  bind_shoulders: RdBindRowView[];
  bind_lstick: RdBindRowView[];
  bind_rstick: RdBindRowView[];
  bind_system: RdBindRowView[];
  avail_face: RdCtlChipView[];
  avail_dpad: RdCtlChipView[];
  avail_shoulders: RdCtlChipView[];
  avail_lstick: RdCtlChipView[];
  avail_rstick: RdCtlChipView[];
  avail_system: RdCtlChipView[];
  bind_face_n: string;
  bind_dpad_n: string;
  bind_shoulders_n: string;
  bind_lstick_n: string;
  bind_rstick_n: string;
  bind_system_n: string;
  bind_face_cls: string;
  bind_dpad_cls: string;
  bind_shoulders_cls: string;
  bind_lstick_cls: string;
  bind_rstick_cls: string;
  bind_system_cls: string;
  bind_g_cls: string;
  socd_cls: string;
  socd_num: string;
  socd_lab: string;
  socd_edit_opts: RdOptionView[];
}

/** One BY-KEY row — `NocturneKeyRow` on the wire (snapshot.rs). */
export interface RdKeyRowView {
  key: string;
  targets: string;
  fns: string;
  cls: string;
  slot: string;
}

/** The Keys tab — `KeyPanel` on the wire, the same struct `/nocturne`'s
 *  By-key view serves (over this page's standard board). */
export interface RdKeyPanelView {
  key_rows: RdKeyRowView[];
  keys_note: string;
  avail_main: RdKeyRowView[];
  avail_nav: RdKeyRowView[];
  avail_num: RdKeyRowView[];
  avail_main_head: string;
  avail_nav_head: string;
  avail_num_head: string;
  avail_main_cls: string;
  avail_nav_cls: string;
  avail_num_cls: string;
}

/** Which of the pane's two READINGS is showing — by control (game side) or
 *  by key (hand side). Same facts, opposite subject (the 4460 tab pair). */
export type InspectorTab = "controls" | "keys";

/** A LIVE chip: a real button wearing the mapper's data-nx verb — the
 *  island's dispatch arms the learn/assign flow from it. */
function liveChip(cls: string, label: string, title: string, nx: string): HTMLButtonElement {
  const button = el("button", cls, label);
  button.type = "button";
  button.dataset.nx = nx;
  button.title = title;
  return button;
}

/** A Keys-tab jump's target functions, consumed by the next Controls
 *  render (the island's locate pass). */
let pendingJumpFns: string | null = null;
export function takePendingJumpFns(): string | null {
  const fns = pendingJumpFns;
  pendingJumpFns = null;
  return fns;
}

/** The six group headings, exactly as nocturne's markup spells them (the
 *  server's filter matches against these words — one vocabulary). */
const GROUPS = [
  "Face buttons",
  "D-pad",
  "Shoulders & triggers",
  "Left stick",
  "Right stick",
  "System",
] as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(pathD: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "n-ico");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathD);
  svg.append(path);
  return svg;
}

// The three Phosphor glyphs nocturne's rows draw (✕ / + / −), verbatim.
const ICON_X =
  "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z";
const ICON_PLUS =
  "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z";
const ICON_MINUS = "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z";
const ICON_COPY =
  "M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z";

function hidden(name: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  return input;
}

function inlineForm(action: string, kind: string, fields: [string, string][]): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "n-inline";
  form.method = "post";
  form.action = action;
  form.dataset.rdForm = kind;
  for (const [name, value] of fields) form.append(hidden(name, value));
  return form;
}



/** One bind row — nocturne's `details.n-bind` shape, class-for-class. */
function bindRow(r: RdBindRowView): HTMLElement {
  const row = document.createElement("details");
  row.className = r.cls;
  row.dataset.fn = r.function;
  row.dataset.slot = r.slot;

  const sum = document.createElement("summary");
  sum.className = "n-bind-sum";
  const txt = el("span", "n-bind-txt");
  txt.append(el("span", "n-bind-label", r.label), el("span", "n-bind-note", r.note));
  const chip = liveChip(r.chip_cls, r.chip, r.chip_title, "chip-learn");
  const add = liveChip(r.add_cls, "", "Add another key to this control", "chip-add");
  add.setAttribute("aria-label", "Add another key to this control");
  add.append(svgIcon(ICON_PLUS));
  const minus = liveChip(
    r.minus_cls,
    "",
    "Remove one key from this control — press it when asked",
    "chip-remove",
  );
  minus.setAttribute("aria-label", "Remove one key from this control");
  minus.append(svgIcon(ICON_MINUS));
  const clear = inlineForm("/redesign/bind/clear", "bind-clear", [
    ["slot", r.slot],
    ["function", r.function],
  ]);
  const clearBtn = el("button", r.clear_cls);
  clearBtn.type = "submit";
  clearBtn.title = "Back to unbound";
  clearBtn.setAttribute("aria-label", "Unbind this control");
  clearBtn.append(svgIcon(ICON_X));
  clear.append(clearBtn);
  sum.append(
    el("span", "n-bind-dot"),
    txt,
    el("span", r.badge_cls, r.badge),
    el("span", "n-bind-verb", "driven by"),
    chip,
    add,
    minus,
    clear,
  );

  const edit = el("div", "n-bedit");
  const press = el("div", "n-bedit-row");
  press.append(el("span", "n-bedit-lab", "Press"));
  for (const [mode, label, title, cls] of [
    ["hold", "Hold", "Held while the key is down", r.hold_cls],
    ["toggle", "Toggle", "A press holds until the next press", r.tog_cls],
  ] as const) {
    const form = inlineForm("/redesign/bind/toggle", "bind-toggle", [
      ["slot", r.slot],
      ["function", r.function],
      ["mode", mode],
    ]);
    const button = el("button", cls, label);
    button.type = "submit";
    button.title = title;
    form.append(button);
    press.append(form);
  }
  const turbo = el("div", "n-bedit-row");
  const turboLab = el("span", "n-bedit-lab", "Turbo");
  turboLab.title =
    "Auto-fire: while the key is held, the button repeats its press automatically. Pick a rate, or type your own (presses a second).";
  turbo.append(turboLab);
  for (const [hz, label, title] of [
    ["0", "Off", "Turn auto-fire off"],
    ["5", "5/s", "Gentle — 5 presses a second"],
    ["10", "10/s", "Standard — 10 presses a second"],
    ["15", "15/s", "Fast — 15 presses a second"],
  ] as const) {
    const form = inlineForm("/redesign/bind/turbo", "bind-turbo", [
      ["slot", r.slot],
      ["function", r.function],
      ["turbo_hz", hz],
    ]);
    const button = el("button", "n-tpre", label);
    button.type = "submit";
    button.title = title;
    form.append(button);
    turbo.append(form);
  }
  const custom = inlineForm("/redesign/bind/turbo", "bind-turbo", [
    ["slot", r.slot],
    ["function", r.function],
  ]);
  custom.classList.add("n-turbo-form");
  const rate = document.createElement("input");
  rate.className = "n-turbo-in";
  rate.type = "text";
  rate.inputMode = "numeric";
  rate.name = "turbo_hz";
  rate.placeholder = "Hz";
  rate.title = "Your own rate — presses a second; 0 turns auto-fire off";
  rate.value = r.turbo;
  const set = el("button", "n-bbtn sm", "Set");
  set.type = "submit";
  custom.append(rate, set);
  turbo.append(custom);
  edit.append(press, turbo);

  row.append(sum, edit);
  return row;
}

/** One bind group — heading with served count, rows, free-control strip. */
function bindGroup(
  label: string,
  cls: string,
  count: string,
  rows: RdBindRowView[],
  chips: RdCtlChipView[],
): HTMLElement {
  const section = el("section", cls);
  const head = el("div", "n-bindg-head");
  head.append(el("span", "n-bindg-lab", label), el("span", "n-bindg-n", count));
  section.append(head);
  for (const row of rows) section.append(bindRow(row));
  const strip = el("div", "n-ctlstrip");
  for (const chip of chips) {
    const free = liveChip(
      chip.cls,
      chip.label,
      "Free — click, then press a key (or click one on the plate)",
      "ctl-assign",
    );
    free.dataset.fn = chip.function;
    strip.append(free);
  }
  section.append(strip);
  return section;
}

/** One key row of the Keys tab — nocturne's `.n-krow`, class-for-class.
 *  The ✕ clear is a REAL form twin (the re-homed /redesign/key/clear); the
 *  jump button opens the same functions in the Controls tab; +/− are the
 *  learn flow and wait for the keyboard migration. */
function keyRow(r: RdKeyRowView, onJump: (fns: string) => void): HTMLElement {
  const row = el("div", r.cls);
  row.dataset.key = r.key;
  row.dataset.fns = r.fns;
  row.append(el("span", "n-krow-chip", r.key), el("span", "n-krow-verb", "drives"));
  const jump = el("button", "n-krow-tg door", r.targets);
  jump.type = "button";
  jump.title = "Open these controls in the Controls view";
  jump.addEventListener("click", () => onJump(r.fns));
  const add = liveChip(
    "n-addchip",
    "",
    "Assign this key to another control — then click that control on the pad",
    "key-assign",
  );
  add.setAttribute("aria-label", "Assign this key to another control");
  add.append(svgIcon(ICON_PLUS));
  const minus = liveChip(
    "n-minus",
    "",
    "Remove this key from one control — click that control on the pad",
    "key-remove",
  );
  minus.setAttribute("aria-label", "Remove this key from one control");
  minus.append(svgIcon(ICON_MINUS));
  const clear = inlineForm("/redesign/key/clear", "key-clear", [
    ["number", r.slot],
    ["key", r.key],
  ]);
  const clearBtn = el("button", "n-krow-clear");
  clearBtn.type = "submit";
  clearBtn.title = "Unbind this key from everything it drives";
  clearBtn.setAttribute("aria-label", "Unbind this key from everything it drives");
  clearBtn.append(svgIcon(ICON_X));
  clear.append(clearBtn);
  row.append(jump, add, minus, clear);
  return row;
}

function availSection(head: string, cls: string, chips: RdKeyRowView[]): HTMLElement {
  const section = el("div", cls);
  const bar = el("div", "n-bindg-head");
  bar.append(el("span", "n-bindg-lab", head));
  const grid = el("div", "n-akey-grid");
  for (const chip of chips) {
    const free = liveChip(
      "n-akey",
      chip.key,
      "Free — click to take this key in hand, then click a control on the pad",
      "rd-akey",
    );
    free.dataset.key = chip.key;
    grid.append(free);
  }
  section.append(bar, grid);
  return section;
}

/** The Keys tab body — nocturne's `.n-krows` view. */
function renderKeysView(keys: RdKeyPanelView, onJump: (fns: string) => void): HTMLElement {
  const wrap = el("div", "n-krows rd-insp-krows");
  wrap.append(
    el(
      "p",
      "n-teach",
      "Each key, and everything it drives. + assigns the key to another control — click that control on the pad.",
    ),
    el("p", "n-foot", keys.keys_note),
  );
  for (const row of keys.key_rows) wrap.append(keyRow(row, onJump));
  wrap.append(
    availSection(keys.avail_main_head, keys.avail_main_cls, keys.avail_main),
    availSection(keys.avail_nav_head, keys.avail_nav_cls, keys.avail_nav),
    availSection(keys.avail_num_head, keys.avail_num_cls, keys.avail_num),
  );
  return wrap;
}

/** The whole controller panel, as inspector rows: the meta strip and slot
 *  verbs always, then the active tab's reading — Controls (six bind groups)
 *  or Keys (the by-key rows). The tab pair is 4460's `.n-vseg`. */
/** One staged macro's lifecycle row (served — compose_macro_rows). */
export interface RdMacroRowView {
  name: string;
  fn_name: string;
  chip: string;
  chip_title: string;
  add_cls: string;
  chip_cls: string;
  meta: string;
  cls: string;
  slot: string;
  edit_href: string;
  toggle_label: string;
  toggle_value: string;
}

/** The macro half of the panel: head count, rows, and the honest note. */
export interface RdMacroSection {
  head: string;
  rows: RdMacroRowView[];
  note: string;
}

/** Macros under the six groups — nocturne's own section, markup kept: the
 *  trigger chips rebind through the SAME learn flow as any control (the
 *  rows carry data-fn="macro.<name>"), enable/disable and delete are real
 *  form twins on this page's verbs, and Edit steps… is the ?macro= door. */
function renderMacroSection(slotVal: string, mac: RdMacroSection): HTMLElement {
  const sec = el("div", "n-macrosec");
  const head = el("div", "n-group-head");
  head.append(el("span", "n-kick", mac.head));
  sec.append(head);
  for (const r of mac.rows) {
    const row = document.createElement("details");
    row.className = r.cls;
    row.dataset.fn = r.fn_name;
    row.dataset.slot = r.slot;
    const sum = document.createElement("summary");
    sum.className = "n-bind-sum";
    const txt = el("span", "n-bind-txt");
    txt.append(el("span", "n-bind-label", r.name), el("span", "n-bind-note", r.meta));
    const add = liveChip(r.add_cls, "", "Add another trigger key", "chip-add");
    add.setAttribute("aria-label", "Add another trigger key");
    add.append(svgIcon(ICON_PLUS));
    sum.append(
      el("span", "n-bind-dot"),
      txt,
      el("span", "n-bind-verb", "started by"),
      liveChip(r.chip_cls, r.chip, r.chip_title, "chip-learn"),
      add,
    );
    const body = el("div", "n-bedit");
    const lifeRow = el("div", "n-bedit-row");
    const toggle = inlineForm("/redesign/macro/toggle", "macro-toggle", [
      ["slot", r.slot],
      ["name", r.name],
      ["enable", r.toggle_value],
    ]);
    const toggleBtn = el("button", "n-bpill", r.toggle_label);
    toggleBtn.type = "submit";
    toggleBtn.title = "A disabled macro keeps every step and never starts";
    toggle.append(toggleBtn);
    lifeRow.append(toggle);
    const editRow = el("div", "n-bedit-row");
    const edit = document.createElement("a");
    edit.className = "n-bbtn n-bbtn-link";
    edit.href = r.edit_href;
    edit.textContent = "Edit steps…";
    const del = document.createElement("details");
    del.className = "n-bdel";
    const delSum = document.createElement("summary");
    delSum.className = "n-bbtn ghost";
    delSum.textContent = "Delete…";
    const delBody = el("div", "n-bdel-body");
    delBody.append(
      el(
        "span",
        "n-bedit-lab",
        "Removes the steps and unbinds its trigger keys — in this draft only.",
      ),
    );
    const delForm = inlineForm("/redesign/macro/delete", "macro-delete", [
      ["slot", r.slot],
      ["name", r.name],
    ]);
    const delBtn = el("button", "n-bbtn danger", "Delete this macro");
    delBtn.type = "submit";
    delForm.append(delBtn);
    delBody.append(delForm);
    del.append(delSum, delBody);
    editRow.append(edit, del);
    body.append(lifeRow, editRow);
    row.append(sum, body);
    sec.append(row);
  }
  const macnew = document.createElement("details");
  macnew.className = "n-macnew";
  const newSum = document.createElement("summary");
  newSum.textContent = "New macro…";
  const newForm = document.createElement("form");
  newForm.className = "n-macnewform";
  newForm.method = "post";
  newForm.action = "/redesign/macro/new";
  newForm.dataset.rdForm = "macro-new";
  newForm.append(hidden("slot", slotVal));
  const nameBox = document.createElement("input");
  nameBox.className = "n-macnewin";
  nameBox.type = "text";
  nameBox.name = "name";
  nameBox.required = true;
  nameBox.maxLength = 40;
  nameBox.placeholder = "hadouken";
  nameBox.setAttribute("aria-label", "What to call the macro");
  const createBtn = el("button", "n-bbtn", "Create");
  createBtn.type = "submit";
  newForm.append(nameBox, createBtn);
  macnew.append(
    newSum,
    newForm,
    el(
      "span",
      "n-macnewnote",
      "It starts with one empty step. The name becomes the table’s, and ‘macro.’ plus it is the control a key can drive.",
    ),
  );
  sec.append(macnew, el("p", "n-devnote", mac.note));
  return sec;
}

export function renderControllerPanel(
  panel: RdPanelView,
  keys: RdKeyPanelView,
  mac: RdMacroSection,
  tab: InspectorTab,
  onTab: (next: InspectorTab) => void,
): HTMLElement[] {
  const rows: HTMLElement[] = [];

  // The meta strip — nocturne's center words, moved to where this page
  // talks about the selected thing.
  const meta = el("div", "n-meta rd-insp-ctrlmeta");
  meta.append(
    el("span", panel.pad_badge_cls, panel.pad_badge),
    el("span", "n-meta-name", panel.pad_name),
    el("span", "n-meta-sub", panel.pad_sub),
  );
  rows.push(meta);

  // The opposite-directions editor (create sets it at birth; this changes
  // it afterwards) — the served visibility class hides it when no roster.
  const socd = document.createElement("form");
  socd.className = panel.socd_cls;
  socd.method = "post";
  socd.action = "/redesign/controller/socd";
  socd.dataset.rdForm = "controller-socd";
  socd.append(el("span", "n-socd-lab", panel.socd_lab), hidden("number", panel.socd_num));
  const select = document.createElement("select");
  select.className = "n-socd-sel";
  select.name = "socd";
  for (const option of panel.socd_edit_opts) {
    const row = document.createElement("option");
    row.value = option.value;
    row.textContent = option.label;
    select.append(row);
  }
  const set = el("button", "n-socd-set", "Set");
  set.type = "submit";
  socd.append(select, set);
  rows.push(socd);

  // The slot verbs nocturne's rack pill carries: duplicate + unbind-all.
  const verbs = el("div", "rd-insp-row rd-insp-ctrlverbs");
  const dup = inlineForm("/redesign/controller/duplicate", "controller-duplicate", [
    ["number", panel.slot_val],
  ]);
  const dupBtn = el("button", "n-autobtn", "");
  dupBtn.type = "submit";
  dupBtn.title = "Duplicate — same layout, same rules, next free slot";
  dupBtn.append(svgIcon(ICON_COPY), document.createTextNode(" Duplicate"));
  dup.append(dupBtn);
  const clearAll = inlineForm("/redesign/bind/clear-all", "bind-clear-all", [
    ["number", panel.slot_val],
  ]);
  const mapAll = el("button", "n-autobtn", "Map all…");
  mapAll.type = "button";
  mapAll.dataset.nx = "rd-automap";
  mapAll.title =
    "Walk every UNBOUND control in turn — press a key for each. Esc skips one; Cancel stops the run.";
  const clearAllBtn = el("button", "n-autobtn danger", "Unbind all");
  clearAllBtn.type = "submit";
  clearAllBtn.title =
    "Every key unbound on this controller — its macros lose their triggers but keep their steps";
  clearAll.append(clearAllBtn);
  verbs.append(dup, mapAll, clearAll);
  rows.push(verbs);

  // The pane's two READINGS of one relation: by control (game side) and by
  // key (hand side) — 4460's own tab pair, wording and classes kept.
  const vseg = el("div", "n-vseg rd-insp-vseg");
  vseg.setAttribute("role", "group");
  vseg.setAttribute("aria-label", "Mapping view");
  for (const [id, label] of [
    ["controls", "Controls"],
    ["keys", "Keys"],
  ] as const) {
    const button = el("button", `n-vseg-btn ${id === "controls" ? "vc" : "vk"}`, label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(tab === id));
    button.addEventListener("click", () => {
      if (tab !== id) onTab(id);
    });
    vseg.append(button);
  }
  rows.push(vseg);

  if (tab === "keys") {
    rows.push(
      renderKeysView(keys, (fns) => {
        // The jump's target is stashed BEFORE the tab change: onTab
        // re-renders synchronously, and the fresh Controls paint consumes
        // it (the island's pending-locate pass).
        pendingJumpFns = fns;
        onTab("controls");
      }),
    );
    if (panel.bind_foot) rows.push(el("p", "n-foot", panel.bind_foot));
    return rows;
  }

  // The six groups, under the one served visibility class.
  const groups = el("div", panel.bind_g_cls);
  groups.append(
    el(
      "p",
      "n-teach",
      "Click a key chip, then press the new key; + adds one, ✕ unbinds. Open a row for press behaviour and turbo.",
    ),
    bindGroup(GROUPS[0], panel.bind_face_cls, panel.bind_face_n, panel.bind_face, panel.avail_face),
    bindGroup(GROUPS[1], panel.bind_dpad_cls, panel.bind_dpad_n, panel.bind_dpad, panel.avail_dpad),
    bindGroup(
      GROUPS[2],
      panel.bind_shoulders_cls,
      panel.bind_shoulders_n,
      panel.bind_shoulders,
      panel.avail_shoulders,
    ),
    bindGroup(
      GROUPS[3],
      panel.bind_lstick_cls,
      panel.bind_lstick_n,
      panel.bind_lstick,
      panel.avail_lstick,
    ),
    bindGroup(
      GROUPS[4],
      panel.bind_rstick_cls,
      panel.bind_rstick_n,
      panel.bind_rstick,
      panel.avail_rstick,
    ),
    bindGroup(
      GROUPS[5],
      panel.bind_system_cls,
      panel.bind_system_n,
      panel.bind_system,
      panel.avail_system,
    ),
  );
  rows.push(groups);

  rows.push(renderMacroSection(panel.slot_val, mac));

  if (panel.bind_foot) rows.push(el("p", "n-foot", panel.bind_foot));
  return rows;
}
