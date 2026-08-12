import { h, createSignal, createList, createShow } from "@getforma/core";

// The island: the whole /start screen — docs/FIRST-RUN.md moments 4 to 7.
//
// Same two halves as every other island: the signal declarations below ARE the
// FMIR slot table, and the same signals are rewritten by the poller in
// start.ts. Read PadsIsland.ts's header for the protocol; this comment is only
// about what is different here.
//
// **This page decides nothing and words nothing.** Every sentence arrives
// composed — the staging view's rosters and ceilings from `ksx-api`, the
// device rows from `DeviceScanView::read`, and the page's own lines from
// `StartLines` / `StartFlags` / `StartRows` in snapshot.rs. `applyStart` below
// is a copier. That is docs/SURFACES.md §1a, and this page has three specific
// reasons to obey it harder than most:
//
//   - MAX_SLOTS and MAX_XINPUT_SLOTS appear in its copy. A `16` typed here is
//     the exact bug the rule exists for (§1a records the Profiles page's).
//   - The persona list is a ROSTER with a can_plug flag per entry. Hardcoding
//     five names would keep offering `dualsense` after it starts plugging, or
//     keep offering it while it cannot.
//   - The split-or-freeze wording, the escape hatch and its scope are safety
//     facts. Paraphrasing the first one is not a style slip: it is the only
//     thing standing between a frozen keyboard and a reboot.
//
// Compiler constraints honored below (see render.rs): dynamic text/attrs are
// bare `() => signalName()` calls, list sources are bare `() => listSignal()`,
// list item bodies use direct member reads only, createShow conditions are
// bare signal calls, and createShows are SIBLINGS — every combined condition
// is decided in Rust (StartFlags) and gets its own signal.

// ── Wire types: serde field names from crates/ksx-studio/src/snapshot.rs ────

export interface StartLines {
  device_line: string;
  device_detail: string;
  boards_line: string;
  prepared_heading: string;
  prepared_line: string;
  capture_heading: string;
  capture_line: string;
  capture_detail: string;
  capture_prepare_cls: string;
  capture_button_cls: string;
  capture_button: string;
  controller_line: string;
  xinput_line: string;
  blocking_line: string;
  preset_line: string;
  mapper_line: string;
  bus_heading: string;
  bus_cls: string;
  ready_line: string;
  play_line: string;
  guide_line: string;
  escape_line: string;
  scope_line: string;
  stage_error: string;
  scan_error: string;
  presets_error: string;
}

export interface StartFlags {
  pill_running: boolean;
  pill_idle: boolean;
  pill_down: boolean;
  stage_down: boolean;
  scan_down: boolean;
  presets_down: boolean;
  bus_warn: boolean;
  has_device: boolean;
  has_prepared: boolean;
  capture_prepare: boolean;
  capture_release: boolean;
  capture_blocked: boolean;
  has_boards: boolean;
  has_experimental: boolean;
  no_boards: boolean;
  has_other: boolean;
  has_notes: boolean;
  has_slots: boolean;
  can_add: boolean;
  slots_full: boolean;
  has_gaps: boolean;
  can_layout: boolean;
  blocking_answered: boolean;
  ready: boolean;
  not_ready: boolean;
  can_discard: boolean;
  session_live: boolean;
  flash_ok: boolean;
  flash_error: boolean;
}

export interface StartBoardRow {
  name: string;
  transport: string;
  backends: string;
  verdict: string;
  caveat: string;
  caveat_cls: string;
  cannot_type: string;
  cannot_type_cls: string;
  path: string;
  selector: string;
  alias: string;
  chosen_cls: string;
  button: string;
}

/** One keyboard ksx is holding. The two identifiers are FORM VALUES only —
 *  the row prints the name and keeps the path in the support details. */
export interface StartPreparedRow {
  name: string;
  transport: string;
  detail: string;
  path: string;
  selector: string;
  instance_id: string;
  note: string;
  note_cls: string;
  form_cls: string;
}

export interface StartOtherRow {
  name: string;
  transport: string;
  reason: string;
  backends: string;
}

export interface StartSlotRow {
  number: string;
  title: string;
  state: string;
  persona: string;
  xinput: string;
  preset: string;
  bindings: string;
  map_href: string;
}

export interface StartOptionRow {
  value: string;
  label: string;
}

export interface StartGapRow {
  label: string;
  gap: string;
  instead: string;
}

export interface StartLayoutRow {
  label: string;
  panel: string;
  players: string;
}

export interface StartBlockingRow {
  name: string;
  title: string;
  detail: string;
  chosen_cls: string;
  button: string;
}

export interface StartTextRow {
  text: string;
}

export interface StartRows {
  boards: StartBoardRow[];
  prepared: StartPreparedRow[];
  experimental: StartBoardRow[];
  other: StartOtherRow[];
  notes: StartTextRow[];
  slots: StartSlotRow[];
  personas: StartOptionRow[];
  gaps: StartGapRow[];
  blocking: StartBlockingRow[];
  layouts: StartOptionRow[];
  layout_details: StartLayoutRow[];
  slot_numbers: StartOptionRow[];
}

/** The staged setup as ksx-api serves it. Only the fields this screen reads
 *  are named — the rest travel and are ignored, which is what keeps a new
 *  served field from breaking hydration. */
export interface StagedSetupView {
  reachable: boolean;
  next_slot: number | null;
  /** The preset name "Add a controller" posts. SERVED, because it becomes a
   *  file name — see snapshot.rs. */
  next_preset: string | null;
  escape_hatch: string;
  blocking_scope: string;
}

export interface SessionView {
  reachable: boolean;
  running: boolean;
  line: string;
  profile: string | null;
}

/** `ksx_api::PadBusView` — can ksx create a virtual controller right now.
 *  Only the two sentences are read here; `blocked` vs `unknown` was already
 *  decided in Rust and arrives as `flags.bus_warn` plus `lines.bus_cls`. */
export interface PadBusView {
  line: string;
  remedy: string;
}

/** Exact stale-action guards for the capture forms. They are served from the
 *  selected board and never rendered as customer copy. There is intentionally
 *  no backend field: only the server may choose the post-mutation backend. */
export interface StartCaptureView {
  expected_selector: string;
  instance_id: string;
}

/** What GET /api/start serves and what the island props carry — one shape
 *  (`StartPayload` in snapshot.rs; parity unit-tested in render_start.rs). */
/** The logon-task card. Every sentence is composed in snapshot.rs; this
 *  screen places them and nothing else. */
export interface StartAutostartView {
  readable: boolean;
  error: string;
  registered: boolean;
  line: string;
  detail: string;
  button: string;
  /** The DIRECTION the button posts, served rather than inferred from
   *  `registered`: a form submitted against a page that has gone stale must do
   *  what its user read, or nothing. */
  enable: boolean;
  stale: boolean;
  stale_detail: string;
}

export interface StartPayload {
  staged: StagedSetupView;
  session: SessionView;
  pad_bus: PadBusView;
  capture: StartCaptureView;
  autostart: StartAutostartView;
  flash: string | null;
  lines: StartLines;
  flags: StartFlags;
  rows: StartRows;
}

// ── The live state store (module-level: one island, page lifetime) ─────────

const [sessionLine, setSessionLine] = createSignal("not collected");
const [deviceLine, setDeviceLine] = createSignal("not collected");
const [deviceDetail, setDeviceDetail] = createSignal("");
const [boardsLine, setBoardsLine] = createSignal("not collected");
const [preparedHeading, setPreparedHeading] = createSignal("");
const [preparedLine, setPreparedLine] = createSignal("");
const [autostartLine, setAutostartLine] = createSignal("");
const [autostartDetail, setAutostartDetail] = createSignal("");
const [autostartButton, setAutostartButton] = createSignal("");
const [autostartStaleDetail, setAutostartStaleDetail] = createSignal("");
const [autostartError, setAutostartError] = createSignal("");
const [autostartEnable, setAutostartEnable] = createSignal("");
const [captureHeading, setCaptureHeading] = createSignal("");
const [captureLine, setCaptureLine] = createSignal("");
const [captureDetail, setCaptureDetail] = createSignal("");
const [capturePrepareCls, setCapturePrepareCls] = createSignal("card wide capture-card");
const [captureButtonCls, setCaptureButtonCls] = createSignal("btn");
const [captureButton, setCaptureButton] = createSignal("");
const [captureSelector, setCaptureSelector] = createSignal("");
const [captureInstance, setCaptureInstance] = createSignal("");
const [controllerLine, setControllerLine] = createSignal("not collected");
const [xinputLine, setXinputLine] = createSignal("not collected");
const [blockingLine, setBlockingLine] = createSignal("not collected");
const [presetLine, setPresetLine] = createSignal("not collected");
const [mapperLine, setMapperLine] = createSignal("not collected");
const [busHeading, setBusHeading] = createSignal("not collected");
const [busCls, setBusCls] = createSignal("card alarm");
const [busLine, setBusLine] = createSignal("not collected");
const [busRemedy, setBusRemedy] = createSignal("");
const [readyLine, setReadyLine] = createSignal("not collected");
const [playLine, setPlayLine] = createSignal("not collected");
const [guideLine, setGuideLine] = createSignal("not collected");
const [escapeLine, setEscapeLine] = createSignal("not collected");
const [scopeLine, setScopeLine] = createSignal("not collected");
const [stageError, setStageError] = createSignal("");
const [scanError, setScanError] = createSignal("");
const [presetsError, setPresetsError] = createSignal("");
const [nextPreset, setNextPreset] = createSignal("");
const [flashLine, setFlashLine] = createSignal("");

const [pillRunning, setPillRunning] = createSignal(false);
const [pillIdle, setPillIdle] = createSignal(false);
const [pillDown, setPillDown] = createSignal(false);
const [stageDown, setStageDown] = createSignal(false);
const [scanDown, setScanDown] = createSignal(false);
const [presetsDown, setPresetsDown] = createSignal(false);
const [busWarn, setBusWarn] = createSignal(false);
const [hasDevice, setHasDevice] = createSignal(false);
const [hasPrepared, setHasPrepared] = createSignal(false);
const [capturePrepare, setCapturePrepare] = createSignal(false);
const [captureRelease, setCaptureRelease] = createSignal(false);
const [captureBlocked, setCaptureBlocked] = createSignal(false);
const [autostartReadable, setAutostartReadable] = createSignal(false);
const [autostartUnreadable, setAutostartUnreadable] = createSignal(false);
const [autostartStale, setAutostartStale] = createSignal(false);
const [hasBoards, setHasBoards] = createSignal(false);
const [hasExperimental, setHasExperimental] = createSignal(false);
const [noBoards, setNoBoards] = createSignal(false);
const [hasOther, setHasOther] = createSignal(false);
const [hasNotes, setHasNotes] = createSignal(false);
const [hasSlots, setHasSlots] = createSignal(false);
const [canAdd, setCanAdd] = createSignal(false);
const [slotsFull, setSlotsFull] = createSignal(false);
const [hasGaps, setHasGaps] = createSignal(false);
const [canLayout, setCanLayout] = createSignal(false);
const [blockingAnswered, setBlockingAnswered] = createSignal(false);
const [ready, setReady] = createSignal(false);
const [notReady, setNotReady] = createSignal(false);
const [canDiscard, setCanDiscard] = createSignal(false);
const [sessionLive, setSessionLive] = createSignal(false);
const [flashOk, setFlashOk] = createSignal(false);
const [flashError, setFlashError] = createSignal(false);

const [boardRows, setBoardRows] = createSignal<StartBoardRow[]>([]);
const [preparedRows, setPreparedRows] = createSignal<StartPreparedRow[]>([]);
const [experimentalRows, setExperimentalRows] = createSignal<StartBoardRow[]>([]);
const [otherRows, setOtherRows] = createSignal<StartOtherRow[]>([]);
const [noteRows, setNoteRows] = createSignal<StartTextRow[]>([]);
const [slotRows, setSlotRows] = createSignal<StartSlotRow[]>([]);
const [personaOptions, setPersonaOptions] = createSignal<StartOptionRow[]>([]);
const [gapRows, setGapRows] = createSignal<StartGapRow[]>([]);
const [blockingRows, setBlockingRows] = createSignal<StartBlockingRow[]>([]);
const [layoutOptions, setLayoutOptions] = createSignal<StartOptionRow[]>([]);
const [layoutRows, setLayoutRows] = createSignal<StartLayoutRow[]>([]);
const [slotOptions, setSlotOptions] = createSignal<StartOptionRow[]>([]);

// ── Applying a payload ──────────────────────────────────────────────────────

/** Write one /api/start payload into every signal (flash excluded — flash is
 *  one-shot action feedback, owned by `applyFlash`). Safe to call before
 *  adoption AND per poll. Copies; derives nothing. */
export function applyStart(p: StartPayload): void {
  const l = p.lines;
  const f = p.flags;
  const r = p.rows;

  setSessionLine(p.session.line);
  setDeviceLine(l.device_line);
  setDeviceDetail(l.device_detail);
  setBoardsLine(l.boards_line);
  setPreparedHeading(l.prepared_heading);
  setPreparedLine(l.prepared_line);
  setAutostartLine(p.autostart.line);
  setAutostartDetail(p.autostart.detail);
  setAutostartButton(p.autostart.button);
  setAutostartStaleDetail(p.autostart.stale_detail);
  setAutostartError(p.autostart.error);
  // "yes" is the only value the server's `checked()` accepts, so the OFF
  // direction posts a value that can never be mistaken for consent.
  setAutostartEnable(p.autostart.enable ? "yes" : "no");
  setAutostartReadable(p.autostart.readable);
  setAutostartUnreadable(!p.autostart.readable);
  setAutostartStale(p.autostart.stale);
  setCaptureHeading(l.capture_heading);
  setCaptureLine(l.capture_line);
  setCaptureDetail(l.capture_detail);
  setCapturePrepareCls(l.capture_prepare_cls);
  setCaptureButtonCls(l.capture_button_cls);
  setCaptureButton(l.capture_button);
  setCaptureSelector(p.capture.expected_selector);
  setCaptureInstance(p.capture.instance_id);
  setControllerLine(l.controller_line);
  setXinputLine(l.xinput_line);
  setBlockingLine(l.blocking_line);
  setPresetLine(l.preset_line);
  setMapperLine(l.mapper_line);
  // The driver banner: heading and severity class from the page's own lines,
  // the two sentences straight off `ksx_api::PadBusView`. Nothing here decides
  // whether the bus is broken or merely unread — that is `flags.bus_warn`
  // plus the class, both settled in Rust.
  setBusHeading(l.bus_heading);
  setBusCls(l.bus_cls);
  setBusLine(p.pad_bus.line);
  setBusRemedy(p.pad_bus.remedy);
  setReadyLine(l.ready_line);
  setPlayLine(l.play_line);
  setGuideLine(l.guide_line);
  setStageError(l.stage_error);
  setScanError(l.scan_error);
  setPresetsError(l.presets_error);
  setEscapeLine(l.escape_line);
  setScopeLine(l.scope_line);
  setNextPreset(p.staged.next_preset ?? "");

  setPillRunning(f.pill_running);
  setPillIdle(f.pill_idle);
  setPillDown(f.pill_down);
  setStageDown(f.stage_down);
  setScanDown(f.scan_down);
  setPresetsDown(f.presets_down);
  setBusWarn(f.bus_warn);
  setHasDevice(f.has_device);
  setHasPrepared(f.has_prepared);
  setCapturePrepare(f.capture_prepare);
  setCaptureRelease(f.capture_release);
  setCaptureBlocked(f.capture_blocked);
  setHasBoards(f.has_boards);
  setHasExperimental(f.has_experimental);
  setNoBoards(f.no_boards);
  setHasOther(f.has_other);
  setHasNotes(f.has_notes);
  setHasSlots(f.has_slots);
  setCanAdd(f.can_add);
  setSlotsFull(f.slots_full);
  setHasGaps(f.has_gaps);
  setCanLayout(f.can_layout);
  setBlockingAnswered(f.blocking_answered);
  setReady(f.ready);
  setNotReady(f.not_ready);
  setCanDiscard(f.can_discard);
  setSessionLive(f.session_live);

  setBoardRows(r.boards);
  setPreparedRows(r.prepared);
  setExperimentalRows(r.experimental);
  setOtherRows(r.other);
  setNoteRows(r.notes);
  setSlotRows(r.slots);
  setPersonaOptions(r.personas);
  setGapRows(r.gaps);
  setBlockingRows(r.blocking);
  setLayoutOptions(r.layouts);
  setLayoutRows(r.layout_details);
  setSlotOptions(r.slot_numbers);
}

/** The studio server itself stopped answering /api/start. Say so and disable
 *  every verb — and do NOT clear the board list, because its rows are the last
 *  real reading of the machine and hiding them would look like an empty PC.
 *
 *  The wording here is the one thing this file owns, and it has no backend twin
 *  by definition: the backend is the thing not answering. */
export function applyUnreachable(): void {
  setSessionLine("ksx is not responding — retrying");
  setPillRunning(false);
  setPillIdle(false);
  setPillDown(true);
  setStageDown(true);
  setStageError(
    "ksx is not responding. Reopen the app and try again. Nothing on this page has been changed.",
  );
  setCanAdd(false);
  setCapturePrepare(false);
  setCaptureRelease(false);
  setCaptureBlocked(true);
  setCaptureHeading("Keyboard capture could not be checked");
  setCaptureLine(
    "ksx is not responding, so this keyboard's capture state is unknown. Nothing was changed.",
  );
  setCaptureDetail("Reopen the app before preparing, releasing, saving, or playing.");
  setReady(false);
  setNotReady(true);
  setReadyLine(
    "ksx is not responding, so Save and Play are temporarily unavailable.",
  );
  setCanDiscard(false);
}

/** One-shot action feedback (POST outcome or the seed's ?flash= value). */
const FLASH_MS = 8000;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

export function applyFlash(flash: string | null | undefined): void {
  if (flashTimer !== undefined) {
    clearTimeout(flashTimer);
    flashTimer = undefined;
  }
  const line = (flash ?? "").trim();
  if (line === "") {
    setFlashLine("");
    setFlashOk(false);
    setFlashError(false);
    return;
  }
  const isError = line.startsWith("error");
  setFlashLine(line);
  setFlashOk(!isError);
  setFlashError(isError);
  flashTimer = setTimeout(() => applyFlash(null), FLASH_MS);
}

// ── The screen (the slot layout test pins its names) ───────────────────────

export function StartIsland() {
  return h(
    "div",
    { class: "studio" },
    h(
      "header",
      { class: "top" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-ksx" }, "ksx"),
        h("span", { class: "brand-studio" }, "Studio"),
      ),
      h(
        "nav",
        { class: "topnav", "aria-label": "screens" },
        h("a", { class: "navlink on", href: "/start", "aria-current": "page" }, "Setup"),
        h("a", { class: "navlink", href: "/map" }, "Controls"),
        h("a", { class: "navlink", href: "/check" }, "Test"),
      ),
      createShow(
        () => pillRunning(),
        () => h("span", { class: "pill pill-run" }, "playing"),
      ),
      createShow(
        () => pillIdle(),
        () => h("span", { class: "pill pill-idle" }, "ready"),
      ),
      createShow(
        () => pillDown(),
        () => h("span", { class: "pill pill-down" }, "needs attention"),
      ),
    ),
    h(
      "main",
      null,
      // ── The three failed reads. Each says what did not happen; none of
      // them draws an empty machine. ──────────────────────────────────────
      createShow(
        () => stageDown(),
        () =>
          h(
            "section",
            { class: "card alarm" },
            h("h2", null, "Setup needs to restart"),
            h("p", { class: "alarmlead" }, () => stageError()),
          ),
      ),
      createShow(
        () => scanDown(),
        () =>
          h(
            "section",
            { class: "card alarm" },
            h("h2", null, "Your devices could not be read"),
            h(
              "p",
              { class: "alarmlead" },
              "Reopen ksx and try again. The empty list below does not mean ",
              "your keyboards are unplugged.",
            ),
            h(
              "details",
              { class: "st-more" },
              h("summary", null, "Support details"),
              h("p", { class: "pdetail" }, () => scanError()),
            ),
          ),
      ),
      createShow(
        () => flashOk(),
        () => h("p", { class: "flash flash-ok" }, () => flashLine()),
      ),
      createShow(
        () => flashError(),
        () => h("p", { class: "flash flash-err" }, () => flashLine()),
      ),
      // ── KEYBOARDS KSX IS HOLDING — the way back, before anything else ───
      //
      // ABOVE step 1 on purpose: a user reading this page because a keyboard
      // stopped typing must not have to walk the setup flow to find the undo.
      // The list comes from the DEVICE TREE (`held_boards` in snapshot.rs), so
      // it is drawn with no config, with an empty staged setup, and while a
      // different keyboard is selected — the three states in which the QA
      // build had no release control at all.
      //
      // Selecting a keyboard remains looking, never a commitment
      // (docs/FIRST-RUN.md §5): nothing here is a side effect of a choice
      // above, and each row's Release is its own consented POST.
      createShow(
        () => hasPrepared(),
        () =>
          h(
            "section",
            { class: "card wide alarm warn capture-card" },
            h("h2", null, () => preparedHeading()),
            h("p", { class: "alarmlead" }, () => preparedLine()),
            h(
              "ul",
              { class: "plist dv-list" },
              createList(
                () => preparedRows(),
                // KEY EVERY FIELD THE ROW RENDERS — see the board list below.
                (b) =>
                  b.name +
                  "|" +
                  b.transport +
                  "|" +
                  b.detail +
                  "|" +
                  b.path +
                  "|" +
                  b.selector +
                  "|" +
                  b.instance_id +
                  "|" +
                  b.note +
                  "|" +
                  b.note_cls +
                  "|" +
                  b.form_cls,
                (b) =>
                  h(
                    "li",
                    { class: "dv-row" },
                    h(
                      "div",
                      { class: "dv-head" },
                      // THE NAME, and nothing else, is the identifier on screen.
                      h("span", { class: "dv-name" }, b.name),
                      h("span", { class: "pill pill-idle" }, b.transport),
                      h("span", { class: "pill pill-run" }, "held by ksx"),
                    ),
                    h("p", { class: "dv-note" }, b.detail),
                    h("p", { class: b.note_cls }, b.note),
                    h(
                      "details",
                      { class: "st-more" },
                      h("summary", null, "Technical details"),
                      h("p", { class: "dv-line mono" }, b.path),
                    ),
                    h(
                      "form",
                      { class: b.form_cls, method: "post", action: "/start/capture/release" },
                      h("input", {
                        type: "hidden",
                        name: "expected_selector",
                        value: b.selector,
                      }),
                      h("input", { type: "hidden", name: "instance_id", value: b.instance_id }),
                      h(
                        "label",
                        { class: "capture-consent" },
                        h("input", {
                          type: "checkbox",
                          name: "confirm_release",
                          value: "yes",
                          required: "",
                        }),
                        h("span", null, "I want this keyboard to type normally again."),
                      ),
                      h(
                        "p",
                        { class: "pactrow" },
                        h(
                          "button",
                          { class: "btn btn-primary", type: "submit" },
                          "Give this keyboard back to Windows",
                        ),
                      ),
                    ),
                  ),
              ),
            ),
            h(
              "p",
              { class: "dv-note" },
              "Windows will show a permission prompt. The app stays open and does not show a command window.",
            ),
          ),
      ),
      // ── STEP 1 (moment 4): CHOOSE A KEYBOARD ────────────────────────────
      h(
        "section",
        { class: "card wide dv-card" },
        h("h2", null, "1 · Choose a keyboard"),
        h("p", { class: "cardline" }, () => deviceLine()),
        createShow(
          () => hasDevice(),
          () =>
            h(
              "p",
              { class: "dv-note" },
              () => deviceDetail(),
            ),
        ),
        h("p", { class: "dv-note" }, () => boardsLine()),
        createShow(
          () => hasBoards(),
          () =>
            h(
              "p",
              { class: "dv-line" },
              "Choose the keyboard you recognize. Bluetooth keyboards can be ",
              "split too; unusual devices appear separately below.",
            ),
        ),
        h(
          "ul",
          { class: "plist dv-list" },
          createList(
            () => boardRows(),
            // KEY EVERY FIELD THE ROW RENDERS. forma reconciles by key and does
            // not patch a row whose key matched, so any member missing from the
            // key freezes at its first paint — render_start.rs's
            // `every_list_row_reconciles_on_every_field_it_renders` reads this
            // file and fails on one that is.
            (b) =>
              b.name +
              "|" +
              b.transport +
              "|" +
              b.backends +
              "|" +
              b.verdict +
              "|" +
              b.caveat +
              "|" +
              b.caveat_cls +
              "|" +
              b.cannot_type +
              "|" +
              b.cannot_type_cls +
              "|" +
              b.path +
              "|" +
              b.selector +
              "|" +
              b.alias +
              "|" +
              b.chosen_cls +
              "|" +
              b.button,
            (b) =>
              h(
                "li",
                { class: "dv-row" },
                h(
                  "div",
                  { class: "dv-head" },
                  // THE NAME, and nothing else, is the identifier on screen.
                  h("span", { class: "dv-name" }, b.name),
                  h("span", { class: "pill pill-idle" }, b.transport),
                  h("span", { class: b.chosen_cls }, "chosen"),
                ),
                h("p", { class: "dv-note" }, b.verdict),
                h("p", { class: b.caveat_cls }, b.caveat),
                h(
                  "details",
                  { class: "st-more" },
                  h("summary", null, "Technical details"),
                  h("p", { class: "dv-line" }, b.backends),
                  h("p", { class: b.cannot_type_cls }, b.cannot_type),
                  h("p", { class: "dv-line mono" }, b.path),
                ),
                h(
                  "form",
                  { class: "dv-form", method: "post", action: "/start/device" },
                  h("input", { type: "hidden", name: "selector", value: b.selector }),
                  h("input", { type: "hidden", name: "alias", value: b.alias }),
                  h("input", { type: "hidden", name: "label", value: b.name }),
                  h("button", { class: "btn btn-primary", type: "submit" }, b.button),
                ),
              ),
          ),
        ),
        createShow(
          () => hasExperimental(),
          () =>
            h(
              "details",
              { class: "st-more dv-experimental" },
              h("summary", null, "Other devices (optional)"),
              h(
                "p",
                { class: "dv-note" },
                "These devices can sometimes work, but they do not identify themselves as ",
                "keyboards. They are here for unusual controllers and experimentation; choose ",
                "one only when you recognize it.",
              ),
              h(
                "ul",
                { class: "plist dv-list" },
                createList(
                  () => experimentalRows(),
                  (b) =>
                    b.name +
                    "|" +
                    b.transport +
                    "|" +
                    b.backends +
                    "|" +
                    b.verdict +
                    "|" +
                    b.caveat +
                    "|" +
                    b.caveat_cls +
                    "|" +
                    b.cannot_type +
                    "|" +
                    b.cannot_type_cls +
                    "|" +
                    b.path +
                    "|" +
                    b.selector +
                    "|" +
                    b.alias +
                    "|" +
                    b.chosen_cls +
                    "|" +
                    b.button,
                  (b) =>
                    h(
                      "li",
                      { class: "dv-row" },
                      h(
                        "div",
                        { class: "dv-head" },
                        h("span", { class: "dv-name" }, b.name),
                        h("span", { class: "pill pill-idle" }, b.transport),
                        h("span", { class: b.chosen_cls }, "chosen"),
                      ),
                      h("p", { class: "dv-note" }, b.verdict),
                      h("p", { class: b.caveat_cls }, b.caveat),
                      h(
                        "details",
                        { class: "st-more" },
                        h("summary", null, "Technical details"),
                        h("p", { class: "dv-line" }, b.backends),
                        h("p", { class: b.cannot_type_cls }, b.cannot_type),
                        h("p", { class: "dv-line mono" }, b.path),
                      ),
                      h(
                        "form",
                        { class: "dv-form", method: "post", action: "/start/device" },
                        h("input", { type: "hidden", name: "selector", value: b.selector }),
                        h("input", { type: "hidden", name: "alias", value: b.alias }),
                        h("input", { type: "hidden", name: "label", value: b.name }),
                        h("button", { class: "btn", type: "submit" }, b.button),
                      ),
                    ),
                ),
              ),
            ),
        ),
        // "There is nothing here" — licensed by ONE flag, the one that is only
        // ever true when the enumeration actually answered.
        createShow(
          () => noBoards(),
          () =>
            h(
              "p",
              { class: "dv-note" },
              "No board on this PC exposes a keyboard interface, so there is ",
              "nothing ksx can split. Plug in the keyboard or arcade encoder you ",
              "want to use and press Rescan.",
            ),
        ),
        h(
          "p",
          { class: "pactrow" },
          // A GET, and it writes nothing: it re-reads the machine. The list is
          // never cached, so arriving here IS a scan — this is the visible
          // control FIRST-RUN.md §5 asks for, so nobody has to know one exists.
          h("a", { class: "btn btn-ghost", href: "/start" }, "Rescan"),
        ),
        createShow(
          () => hasOther(),
          () =>
            h(
              "details",
              { class: "st-more" },
              h("summary", null, "Devices that cannot be picked, and why"),
              h(
                "ul",
                { class: "plist dv-list" },
                createList(
                  () => otherRows(),
                  (o) => o.name + "|" + o.transport + "|" + o.reason + "|" + o.backends,
                  (o) =>
                    h(
                      "li",
                      { class: "dv-row quiet" },
                      h("span", { class: "dv-name" }, o.name),
                      h("span", { class: "pill pill-idle" }, o.transport),
                      h("span", { class: "dv-line" }, o.reason),
                      h("span", { class: "dv-line" }, o.backends),
                    ),
                ),
              ),
            ),
        ),
        createShow(
          () => hasNotes(),
          () =>
            h(
              "details",
              { class: "st-more" },
              h("summary", null, "Support details"),
              h(
                "ul",
                { class: "plist dv-list" },
                createList(
                  () => noteRows(),
                  (n) => n.text,
                  (n) =>
                    h("li", { class: "dv-row quiet" }, h("span", { class: "dv-line" }, n.text)),
                ),
              ),
            ),
        ),
      ),
      // ── CAPTURE PREPARATION — scalar state, never another device list ───
      //
      // These are three sibling shows because Rust has already decided the
      // mutually-exclusive state. The forms post the exact served guards and
      // explicit consent only; neither carries a backend or helper command.
      createShow(
        () => capturePrepare(),
        () =>
          h(
            "section",
            { class: () => capturePrepareCls() },
            h("h2", null, () => captureHeading()),
            h("p", { class: "cardline" }, () => captureLine()),
            h("p", { class: "dv-note" }, () => captureDetail()),
            h(
              "form",
              {
                class: "capture-form",
                method: "post",
                action: "/start/capture/prepare",
              },
              h("input", {
                type: "hidden",
                name: "expected_selector",
                value: () => captureSelector(),
              }),
              h("input", {
                type: "hidden",
                name: "instance_id",
                value: () => captureInstance(),
              }),
              h(
                "label",
                { class: "capture-consent" },
                h("input", {
                  type: "checkbox",
                  name: "confirm_spare_keyboard",
                  value: "yes",
                  required: "",
                }),
                h("span", null, "I connected and tested a different keyboard that can still type."),
              ),
              h(
                "label",
                { class: "capture-consent" },
                h("input", {
                  type: "checkbox",
                  name: "confirm_rebind",
                  value: "yes",
                  required: "",
                }),
                h(
                  "span",
                  null,
                  "I understand this selected keyboard will stop ordinary typing until I release it here, and I will release it before connecting another identical keyboard.",
                ),
              ),
              h(
                "label",
                { class: "capture-consent" },
                h("input", {
                  type: "checkbox",
                  name: "confirm_machine_certificate",
                  value: "yes",
                  required: "",
                }),
                h(
                  "span",
                  null,
                  "I allow ksx to install a machine-local signing certificate for this computer's generated device package.",
                ),
              ),
              h(
                "p",
                { class: "pactrow" },
                h(
                  "button",
                  { class: () => captureButtonCls(), type: "submit" },
                  () => captureButton(),
                ),
              ),
            ),
            h(
              "p",
              { class: "dv-note" },
              "Windows will show a permission prompt. The app stays open and does not show a command window.",
            ),
          ),
      ),
      createShow(
        () => captureRelease(),
        () =>
          h(
            "section",
            { class: "card wide capture-card capture-ready" },
            h("h2", null, () => captureHeading()),
            h("p", { class: "cardline" }, () => captureLine()),
            h("p", { class: "dv-note" }, () => captureDetail()),
            h(
              "form",
              {
                class: "capture-form",
                method: "post",
                action: "/start/capture/release",
              },
              h("input", {
                type: "hidden",
                name: "expected_selector",
                value: () => captureSelector(),
              }),
              h("input", {
                type: "hidden",
                name: "instance_id",
                value: () => captureInstance(),
              }),
              h(
                "label",
                { class: "capture-consent" },
                h("input", {
                  type: "checkbox",
                  name: "confirm_release",
                  value: "yes",
                  required: "",
                }),
                h("span", null, "I want to return this selected keyboard to ordinary typing."),
              ),
              h(
                "p",
                { class: "pactrow" },
                h("button", { class: "btn", type: "submit" }, "Release selected keyboard"),
              ),
            ),
          ),
      ),
      createShow(
        () => captureBlocked(),
        () =>
          h(
            "section",
            { class: "card wide alarm warn capture-card" },
            h("h2", null, () => captureHeading()),
            h("p", { class: "alarmlead" }, () => captureLine()),
            h("p", { class: "alarmlead" }, () => captureDetail()),
          ),
      ),
      // ── STEP 2 (moment 5): CHOOSE A CONTROLLER ──────────────────────────
      h(
        "section",
        { class: "card wide" },
        h("h2", null, "2 · Choose a controller"),
        h("p", { class: "cardline" }, () => controllerLine()),
        h(
          "ul",
          { class: "plist" },
          createList(
            () => slotRows(),
            (s) =>
              s.number +
              "|" +
              s.title +
              "|" +
              s.state +
              "|" +
              s.persona +
              "|" +
              s.xinput +
              "|" +
              s.preset +
              "|" +
              s.bindings +
              "|" +
              s.map_href,
            (s) =>
              h(
                "li",
                null,
                h(
                  "div",
                  { class: "pmeta" },
                  h("span", { class: "ptitle" }, s.title),
                  h("span", { class: "pill pill-ok" }, s.state),
                  h("span", { class: "pdetail" }, s.persona),
                  h("span", { class: "pdetail" }, s.xinput),
                  h("span", { class: "pdetail mono" }, s.preset),
                  h("span", { class: "pdetail" }, s.bindings),
                ),
                h(
                  "div",
                  { class: "pactrow" },
                  h("a", { class: "btn btn-primary", href: s.map_href }, "Choose controls"),
                  h(
                    "form",
                    { method: "post", action: "/start/controller/remove" },
                    h("input", { type: "hidden", name: "number", value: s.number }),
                    h("button", { class: "btn btn-ghost", type: "submit" }, "Remove"),
                  ),
                ),
              ),
          ),
        ),
        createShow(
          () => hasSlots(),
          () =>
            h(
              "div",
              null,
              h("p", { class: "dv-line" }, () => xinputLine()),
              h(
                "form",
                { class: "pactrow", method: "post", action: "/start/controller/persona" },
                h(
                  "label",
                  { class: "bindlabel", for: "persona-slot" },
                  "change",
                  h(
                    "select",
                    { id: "persona-slot", name: "number" },
                    createList(
                      () => slotOptions(),
                      (o) => o.value + "|" + o.label,
                      (o) => h("option", { value: o.value }, o.label),
                    ),
                  ),
                ),
                h(
                  "label",
                  { class: "bindlabel", for: "persona-change" },
                  "to",
                  h(
                    "select",
                    { id: "persona-change", name: "persona" },
                    createList(
                      () => personaOptions(),
                      (o) => o.value + "|" + o.label,
                      (o) => h("option", { value: o.value }, o.label),
                    ),
                  ),
                ),
                h("button", { class: "btn", type: "submit" }, "Change controller"),
              ),
            ),
        ),
        createShow(
          () => canAdd(),
          () =>
            h(
              "form",
              { class: "pactrow", method: "post", action: "/start/controller" },
              h(
                "label",
                { class: "bindlabel", for: "persona" },
                "as what",
                h(
                  "select",
                  { id: "persona", name: "persona" },
                  createList(
                    () => personaOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              // The LAYOUT it starts from. Served, default first — so a user
              // who never opens this menu still gets a pad that does
              // something, which is the difference between "ready" and a
              // controller Play refuses.
              h(
                "label",
                { class: "bindlabel", for: "layout" },
                "starting from",
                h(
                  "select",
                  { id: "layout", name: "layout" },
                  createList(
                    () => layoutOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              // The preset name is SERVED, because it becomes a file name.
              // Nothing on this page asks anybody to type one.
              h("input", { type: "hidden", name: "preset", value: () => nextPreset() }),
              h("button", { class: "btn btn-primary", type: "submit" }, "Add this controller"),
            ),
        ),
        createShow(
          () => slotsFull(),
          () =>
            h(
              "p",
              { class: "warn" },
              "This setup already has the maximum number of controllers. Remove one to add a different ",
              "controller.",
            ),
        ),
        createShow(
          () => hasGaps(),
          () =>
            h(
              "details",
              { class: "st-more" },
              h("summary", null, "Controllers this build cannot create"),
              h(
                "ul",
                { class: "plist dv-list" },
                createList(
                  () => gapRows(),
                  (g) => g.label + "|" + g.gap + "|" + g.instead,
                  (g) =>
                    h(
                      "li",
                      { class: "dv-row" },
                      h("span", { class: "dv-name" }, g.label),
                      h("p", { class: "dv-note" }, g.gap),
                      h("p", { class: "dv-line" }, g.instead),
                    ),
                ),
              ),
            ),
        ),
      ),
      // ── STEP 3 (moment 6): MAP IT, AND THE ONE QUESTION ─────────────────
      h(
        "section",
        { class: "card wide" },
        h("h2", null, "3 · Map it"),
        h("p", { class: "cardline" }, () => presetLine()),
        createShow(
          () => presetsDown(),
          () =>
            h(
              "div",
              { class: "warnbox" },
              h("p", { class: "warn" }, "Controller layouts are temporarily unavailable."),
              h(
                "details",
                { class: "st-more" },
                h("summary", null, "Support details"),
                h("p", { class: "pdetail" }, () => presetsError()),
              ),
            ),
        ),
        // GIVE A CONTROLLER A LAYOUT. Two selects and one submit, rather than
        // a form per staged row: a createList inside a createList is not a
        // shape this compiler emits, and the layout menu is the same menu for
        // every row.
        createShow(
          () => canLayout(),
          () =>
            h(
              "form",
              { class: "pactrow", method: "post", action: "/start/controller/layout" },
              h(
                "label",
                { class: "bindlabel", for: "layout-slot" },
                "give",
                h(
                  "select",
                  { id: "layout-slot", name: "number" },
                  createList(
                    () => slotOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              h(
                "label",
                { class: "bindlabel", for: "layout-id" },
                "the layout",
                h(
                  "select",
                  { id: "layout-id", name: "layout" },
                  createList(
                    () => layoutOptions(),
                    (o) => o.value + "|" + o.label,
                    (o) => h("option", { value: o.value }, o.label),
                  ),
                ),
              ),
              h("button", { class: "btn", type: "submit" }, "Use this layout"),
            ),
        ),
        h(
          "details",
          { class: "st-more" },
          h("summary", null, "What each layout expects"),
          h(
            "ul",
            { class: "plist dv-list" },
            createList(
              () => layoutRows(),
              (l) => l.label + "|" + l.panel + "|" + l.players,
              (l) =>
                h(
                  "li",
                  { class: "dv-row" },
                  h("span", { class: "dv-name" }, l.label),
                  h("p", { class: "dv-note" }, l.panel),
                  h("p", { class: "dv-line" }, l.players),
                ),
            ),
          ),
        ),
        h("p", { class: "dv-note" }, () => mapperLine()),
      ),
      h(
        "section",
        { class: "card wide warnbox" },
        h("h2", null, "Freeze this keyboard, or split it?"),
        h(
          "p",
          { class: "cardline" },
          "One question, and it decides whether you can still type while you ",
          "play. It is asked once and it is not asked again.",
        ),
        h("p", { class: "cardline" }, () => blockingLine()),
        h(
          "ul",
          { class: "plist dv-list" },
          createList(
            () => blockingRows(),
            (o) => o.name + "|" + o.title + "|" + o.detail + "|" + o.chosen_cls + "|" + o.button,
            (o) =>
              h(
                "li",
                { class: "dv-row" },
                h(
                  "div",
                  { class: "dv-head" },
                  h("span", { class: "dv-name" }, o.title),
                  h("span", { class: o.chosen_cls }, "answered"),
                ),
                h("p", { class: "dv-note" }, o.detail),
                h(
                  "form",
                  { class: "dv-form", method: "post", action: "/start/blocking" },
                  h("input", { type: "hidden", name: "blocking", value: o.name }),
                  h("button", { class: "btn", type: "submit" }, o.button),
                ),
              ),
          ),
        ),
        createShow(
          () => blockingAnswered(),
          () =>
            h(
              "p",
              { class: "dv-line" },
              "You can change this answer as often as you like. It stays on ",
              "this screen until you save.",
            ),
        ),
        // The two things §3 requires on this screen, not buried. Both are
        // ksx-api's own sentences, arriving on the payload.
        h("p", { class: "dv-warn" }, () => escapeLine()),
        h("p", { class: "dv-note" }, () => scopeLine()),
      ),
      // ── The driver, said BEFORE the button that needs it ─────────────────
      //
      // Every persona ksx can plug goes out through ViGEmBus, so a machine
      // without it stages perfectly, saves perfectly and then plugs nothing.
      // That is FIRST-RUN.md §6's first forbidden shape — a screen reporting
      // success while nothing works — and the only place to prevent it is
      // above the button.
      //
      // ONE createShow, deliberately: `bus_warn` is true both for a bus known
      // not to work and for one nothing could be learned about, and the two
      // are told apart by the heading and the class, which are decided in
      // Rust. A second createShow would need a second copy of these three
      // slots, and the seam fills only the first slot of a given name.
      //
      // Reading this changes nothing. `/start` never installs a driver
      // (SURFACES.md §3 marks that column `never`); the remedy is a sentence
      // naming the installer, not a button that runs one.
      createShow(
        () => busWarn(),
        () =>
          h(
            "section",
            { class: () => busCls() },
            h("h2", null, () => busHeading()),
            h("p", { class: "alarmlead" }, () => busLine()),
            h("p", { class: "alarmlead" }, () => busRemedy()),
          ),
      ),
      // ── STEP 4 (moment 7): PLAY ─────────────────────────────────────────
      h(
        "section",
        { class: "card wide" },
        h("h2", null, "4 · Play"),
        h("p", { class: "cardline" }, () => readyLine()),
        h("p", { class: "cardline" }, () => playLine()),
        h(
          "p",
          { class: "cardline" },
          "Saving and playing are separate. Save keeps this setup for later; ",
          "Play uses what is on this screen now and saves nothing. Either works ",
          "without the other.",
        ),
        createShow(
          () => sessionLive(),
          () =>
            h(
              "p",
              { class: "warn" },
              "A game is already using this app. Play now will stop that session and replace ",
              "it with the setup on this screen. Nothing is saved unless you choose Save.",
            ),
        ),
        createShow(
          () => ready(),
          () =>
            h(
              "div",
              { class: "pactrow" },
              h(
                "form",
                { method: "post", action: "/start/save" },
                h("button", { class: "btn", type: "submit" }, "Save this setup"),
              ),
              h(
                "form",
                { method: "post", action: "/start/play" },
                h("button", { class: "btn btn-primary", type: "submit" }, "Play now"),
              ),
            ),
        ),
        createShow(
          () => notReady(),
          () =>
            h(
              "div",
              { class: "controls off" },
              h("button", { class: "btn", disabled: "" }, "Save this setup"),
              h("button", { class: "btn", disabled: "" }, "Play now"),
            ),
        ),
        h("p", { class: "dv-note" }, () => guideLine()),
        h(
          "p",
          { class: "pactrow" },
          h(
            "a",
            { class: "btn btn-ghost", href: "ms-settings:gaming-gamebar" },
            "Open Windows Game Bar settings",
          ),
        ),
        createShow(
          () => canDiscard(),
          () =>
            h(
              "p",
              { class: "pactrow" },
              h(
                "form",
                { method: "post", action: "/start/discard" },
                h("button", { class: "btn btn-ghost", type: "submit" }, "Start over"),
              ),
            ),
        ),
      ),
      // ── STEP 4: COME UP ON ITS OWN ──────────────────────────────────────
      // Last, because it is the step that only makes sense once the rest
      // works: it makes moment 7 repeat with nobody standing at the cabinet.
      // A per-user scheduled task, so one tick box and no UAC — the consent
      // here is sized to what is actually at risk, unlike the capture card
      // above it.
      h(
        "section",
        { class: "card wide" },
        h("h2", null, "4 · Start on its own"),
        h("p", { class: "cardline" }, () => autostartLine()),
        createShow(
          () => autostartStale(),
          () => h("p", { class: "alarmlead" }, () => autostartStaleDetail()),
        ),
        createShow(
          () => autostartUnreadable(),
          () => h("p", { class: "dv-note warn" }, () => autostartError()),
        ),
        createShow(
          () => autostartReadable(),
          () =>
            h(
              "div",
              null,
              h("p", { class: "dv-note" }, () => autostartDetail()),
              h(
                "form",
                { class: "capture-form", method: "post", action: "/start/autostart" },
                h("input", {
                  type: "hidden",
                  name: "enable",
                  value: () => autostartEnable(),
                }),
                h(
                  "label",
                  { class: "capture-consent" },
                  h("input", {
                    type: "checkbox",
                    name: "confirm_autostart",
                    value: "yes",
                    required: "",
                  }),
                  h("span", null, "I want to change what happens when I sign in."),
                ),
                h(
                  "p",
                  { class: "pactrow" },
                  h("button", { class: "btn", type: "submit" }, () => autostartButton()),
                ),
              ),
            ),
        ),
      ),
      h(
        "section",
        { class: "card wide" },
        h("h2", null, "Saved games"),
        h(
          "p",
          { class: "cardline" },
          "Create, repair or remove saved games that remember a program, ",
          "player count and controller layout.",
        ),
        h(
          "p",
          { class: "pactrow" },
          h("a", { class: "btn btn-ghost", href: "/profiles" }, "Manage saved games"),
        ),
      ),
    ),
    h(
      "footer",
      null,
      h(
        "p",
        null,
        "Your choices stay on this screen until you press Save. Play uses them ",
        "for this session without saving.",
        h("span", { class: "product-hidden", "aria-hidden": "true" }, () => sessionLine()),
        ".",
      ),
    ),
  );
}
