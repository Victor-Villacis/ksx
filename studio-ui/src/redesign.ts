import { activateIslands } from "@getforma/core";

// The compiler's island-first entry pattern (parseEntryPoint): the imported
// `*Page` component NOT in the activateIslands registry is the SSR root.
// RedesignPage never runs in the browser — esbuild tree-shakes it — but this
// import is what anchors IR emission. Do not remove it.
import { RedesignPage } from "./RedesignPage";
import {
  applyRedesign,
  applyRedesignFlash,
  initRedesignCanvas,
  rdAnnounce,
  RedesignIsland,
  redesignControlsFor,
  redesignFormProductDisabled,
  redesignGhostHeld,
  redesignLearnSource,
  redesignOperationalState,
  redesignPads,
  returnSharedPolicyEditor,
  redesignSelectedSlot,
  redesignSetLivePaths,
  redesignWire,
  setRedesignRefreshHealth,
  setRedesignRefresh,
  setRedesignDeviceMutation,
  unparkController,
  type RedesignDeviceMutationOptions,
  type RdDeviceRowView,
  type RedesignPayload,
} from "./RedesignIsland";
import { mapperWire } from "./redesign-mapper";
import { macWire } from "./redesign-macro-editor";
import {
  createRedesignLiveFeedback,
  type RedesignLiveFeedback,
  type RedesignLiveSession,
} from "./redesign-live";

void RedesignPage; // compile-time anchor only (see above)

/** The SOURCE payload the server embedded (render.rs `PAYLOAD_SCRIPT_ID`) —
 *  not the island's `props` argument, which carries the RENDERED SLOT
 *  VALUES. See status.ts for the longer note (dogfood ledger #8/#19). */
function embeddedPayload<T>(): T | null {
  const el = document.getElementById("__ksx-payload");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

/** Every payload read crosses one coordinator. A foreground repaint supersedes
 *  an older read; a background tick never interrupts a foreground one. The
 *  generation check remains after AbortController because an already-resolved
 *  response can still queue its continuation before the abort is observed. */
type RefreshKind = "foreground" | "poll";
interface ActiveRefresh {
  generation: number;
  kind: RefreshKind;
  controller: AbortController;
  promise: Promise<boolean>;
}

let refreshGeneration = 0;
let activeRefresh: ActiveRefresh | null = null;
let newestSettledRefresh = { generation: 0, result: false };
let latestAppliedRefresh = { generation: 0, fresh: false };
let liveFeedback: RedesignLiveFeedback | null = null;
let redesignRoot: HTMLElement | null = null;
let refreshHealth: "online" | "stale" = "online";
interface DeviceScanStatus {
  authoritative: boolean;
  usbAuthoritative: boolean;
  bluetoothAuthoritative: boolean;
  line: string;
}
let latestDeviceScanStatus: DeviceScanStatus | null = null;
let discardConfirmationAuthority: string | null = null;
let captureConfirmationAuthority: string | null = null;
const IDENTIFY_OK_FLASH =
  "Keyboard identified and selected. Nothing has been captured, saved, or started.";
const IDENTIFY_CANCELLED_FLASH = "Keyboard identification cancelled. Nothing changed.";
const DEVICE_REMOVE_CONFIRM_FLASH =
  "error: This keyboard has controller mappings. Confirm Remove to discard those unsaved routes; nothing was changed.";
let identifyRequestController: AbortController | null = null;
let identifyRequestAttempt: string | null = null;
let identifyCancellationAccepted = false;
let identifyCancellationTask: Promise<boolean> | null = null;
let identifyLifecycleWired = false;

function applyAuthority(operations: RedesignPayload["operations"] | null | undefined): string {
  if (!operations) return "";
  return JSON.stringify([
    operations.draft_revision ?? "",
    operations.active_stage_revision ?? "",
    operations.session?.origin ?? "",
  ]);
}

/** A checked confirmation belongs to the authority that was visible when it
 * was checked. A poll may replace hidden revision/device values in place, so
 * clear consent before applying a payload for a different target. */
function resetChangedConfirmations(payload: RedesignPayload): void {
  const root = redesignRoot;
  const nextDraft = payload.operations?.draft_revision ?? "";
  if (root && discardConfirmationAuthority !== null && discardConfirmationAuthority !== nextDraft) {
    const startOver = root.querySelector<HTMLDetailsElement>(".rd-start-over");
    const ownedFocus = startOver?.contains(document.activeElement) === true;
    const confirmation = root.querySelector<HTMLInputElement>('input[name="confirm_discard"]');
    if (confirmation) confirmation.checked = false;
    startOver?.removeAttribute("open");
    // An in-page mutation has its own outcome/focus lifecycle. This recovery
    // is specifically for a passive payload that invalidated consent while
    // the user was still reading it.
    if (ownedFocus && root.dataset.rdMutationPending !== "true") {
      rdAnnounce("The draft changed elsewhere, so the Start over confirmation was cleared.");
      window.requestAnimationFrame(() => {
        const currentStartOver = root.querySelector<HTMLElement>(".rd-start-over > summary");
        const profile = root.querySelector<HTMLElement>(".rd-profile-sum");
        const target = renderedLifecycleTarget(currentStartOver)
          ? currentStartOver
          : renderedLifecycleTarget(profile)
            ? profile
            : null;
        target?.focus({ preventScroll: true });
      });
    }
  }
  discardConfirmationAuthority = nextDraft;

  const capture = payload.capture;
  const nextCapture = JSON.stringify([
    capture?.mode ?? "none",
    capture?.selector ?? "",
    capture?.instance ?? "",
    (capture?.held ?? []).map((row) => [row.selector, row.instance, row.can_release]),
  ]);
  if (root && captureConfirmationAuthority !== null && captureConfirmationAuthority !== nextCapture) {
    root.querySelectorAll<HTMLInputElement>(
      'input[name="confirm_spare_keyboard"], input[name="confirm_rebind"], ' +
        'input[name="confirm_machine_certificate"], input[name="confirm_release"]',
    ).forEach((confirmation) => {
      confirmation.checked = false;
    });
  }
  captureConfirmationAuthority = nextCapture;
}

function reportRefreshHealth(state: "online" | "stale", message = ""): void {
  setRedesignRefreshHealth(state, message);
  if (state === refreshHealth) return;
  refreshHealth = state;
  rdAnnounce(
    state === "stale"
      ? message || "Workbench updates are paused."
      : "Workbench updates resumed.",
  );
}

/** Apply one payload and immediately renew the separate live-paint license.
 * Durable product state and 60 Hz decoration deliberately share only these
 * revision/session facts. */
function applyPayload(payload: RedesignPayload): void {
  resetChangedConfirmations(payload);
  const devices = payload.devices;
  const authoritative = devices?.scan_authoritative === true;
  latestDeviceScanStatus = devices
    ? {
        authoritative,
        // Older Studio payloads exposed only the aggregate flag. Preserve
        // that rolling-upgrade contract here just as the island does.
        usbAuthoritative: devices.usb_scan_authoritative ?? authoritative,
        bluetoothAuthoritative: devices.bluetooth_scan_authoritative ?? authoritative,
        line: devices.scan_line?.trim() ?? "",
      }
    : null;
  applyRedesign(payload);
  liveFeedback?.invalidateTargets();
  const operations = payload.operations;
  const session = operations?.session;
  if (redesignRoot) {
    const restart = applyRestartDialog(redesignRoot);
    const restartAuthority = restart?.dataset.rdApplyAuthority ?? "";
    const restartStillValid = Boolean(
      session?.running &&
      operations?.apply?.allowed === true &&
      restartAuthority &&
      restartAuthority === applyAuthority(operations),
    );
    if (restart && !restart.hidden && !restartStillValid) {
      closeApplyRestartDialog(redesignRoot, false);
      if (redesignRoot.dataset.rdMutationPending !== "true") {
        redesignRoot.querySelector<HTMLElement>(".rd-profile-sum")?.focus({ preventScroll: true });
      }
      rdAnnounce("The draft or running session changed, so the replacement decision was closed.");
    }
  }
  const liveSession: RedesignLiveSession | null = session
    ? {
        reachable: session.reachable,
        running: session.running,
        origin: session.origin,
        profile: session.profile,
        elapsed: session.active?.elapsed,
        structureRevision: operations?.draft_revision,
        runtimeRevision:
          operations?.active_stage_revision || session.active?.stage_revision,
      }
    : null;
  liveFeedback?.reconcileSession(liveSession);
}

function newerRefresh(generation: number): Promise<boolean> | null {
  const active = activeRefresh;
  return active && active.generation > generation ? active.promise : null;
}

async function successorRefreshResult(generation: number): Promise<boolean> {
  const active = newerRefresh(generation);
  if (active) return active;
  return newestSettledRefresh.generation > generation
    ? newestSettledRefresh.result
    : false;
}

async function performRefresh(
  generation: number,
  controller: AbortController,
  fresh: boolean,
): Promise<boolean> {
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    // The selected controller and the open macro ride the URL (the
    // nocturne `?slot=&macro=` doors), so a refresh serves what the page
    // is looking at.
    const current = new URLSearchParams(window.location.search);
    const params = new URLSearchParams();
    for (const name of ["slot", "source", "macro", "q"]) {
      const value = current.get(name);
      if (value) params.set(name, value);
    }
    if (fresh) params.set("fresh", "1");
    const query = params.toString();
    const res = await fetch(query ? `/api/redesign?${query}` : "/api/redesign", {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (generation === refreshGeneration) {
        reportRefreshHealth(
          "stale",
          "Workbench updates are paused. Retrying…",
        );
      }
      return successorRefreshResult(generation);
    }
    const payload = (await res.json()) as RedesignPayload;
    if (generation !== refreshGeneration) {
      return successorRefreshResult(generation);
    }
    applyPayload(payload);
    latestAppliedRefresh = { generation, fresh };
    reportRefreshHealth("online");
    return true;
  } catch {
    // A superseded caller follows the newer repaint instead of reporting a
    // false failure while that repaint is still in flight. A genuinely failed
    // latest request keeps the page's last truth.
    if (generation === refreshGeneration) {
      reportRefreshHealth(
        "stale",
        "Workbench updates are paused. Retrying…",
      );
    }
    return successorRefreshResult(generation);
  } finally {
    window.clearTimeout(timeout);
    if (activeRefresh?.generation === generation) activeRefresh = null;
  }
}

function beginRefresh(kind: RefreshKind, fresh: boolean): ActiveRefresh | null {
  // A tick is opportunistic. It never aborts or queues behind a user-driven
  // repaint; the next two-second tick will carry the same external truth.
  if (kind === "poll" && activeRefresh !== null) return null;

  const generation = ++refreshGeneration;
  activeRefresh?.controller.abort();
  const controller = new AbortController();
  const promise = performRefresh(generation, controller, fresh).then((result) => {
    if (generation > newestSettledRefresh.generation) {
      newestSettledRefresh = { generation, result };
    }
    return result;
  });
  const attempt = { generation, kind, controller, promise };
  activeRefresh = attempt;
  return attempt;
}

function refresh(kind: RefreshKind = "foreground", fresh = false): Promise<boolean> {
  return beginRefresh(kind, fresh)?.promise ?? Promise.resolve(false);
}

/** Unlike ordinary consumers, explicit Rescan cannot inherit the success of
 * a newer cached repaint when its `fresh=1` read is superseded. It succeeds
 * only when this exact generation applied the payload it requested. */
async function refreshExact(kind: RefreshKind, fresh: boolean): Promise<boolean> {
  const attempt = beginRefresh(kind, fresh);
  if (!attempt || !(await attempt.promise)) return false;
  return latestAppliedRefresh.generation === attempt.generation &&
    latestAppliedRefresh.fresh === fresh;
}

/** Beginning a mutation retires every read that may have sampled pre-write
 * state. Advancing the generation is the backstop when the network stack has
 * already completed the response and abort can no longer recall it. */
function cancelActiveRefresh(): void {
  const active = activeRefresh;
  if (!active) return;
  refreshGeneration += 1;
  activeRefresh = null;
  active.controller.abort();
}

/** The background tick nocturne keeps (its 2 s poll): between verb-driven
 *  refreshes, another tab's edits still reach this page — armed mapping
 *  gestures retire when their authority goes stale, cords repaint, counts
 *  follow. An open input-policy disclosure is deliberately not a pause: it
 *  is stable DOM and can safely reconcile while external Save/Play/Stop
 *  truth advances. Paused while the tab is hidden; the visibility return
 *  refreshes once immediately. */
function startBackgroundPoll(root: HTMLElement): void {
  let inFlight = false;
  const tick = async () => {
    if (
      document.visibilityState !== "visible" ||
      inFlight ||
      pendingMutationRoots.has(root)
    ) return;
    inFlight = true;
    try {
      await refresh("poll");
    } finally {
      inFlight = false;
    }
  };
  window.setInterval(() => void tick(), 2000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void tick();
  });
}

/** Fetch-enhance only explicitly typed redesign forms. Future widgets must
 *  opt into a lifecycle instead of silently inheriting Theme's close/focus
 *  behavior. With JavaScript off these remain ordinary POST + 303 forms;
 *  with it on, the outcome and served payload repaint in place. */
function wireForms(root: HTMLElement): void {
  // The Add tray's buttons are not forms, but they mutate/read the same
  // authority as every enhanced POST below. Capture their clicks before the
  // canvas shell's delegated handler so a synthetic click cannot bypass the
  // native `disabled` guard while another transaction owns the island.
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const shellControl = target.closest<HTMLButtonElement>(
      '[data-nx="rd-dev-toggle"], [data-nx="rd-offline-remove"], [data-nx="rd-rescan"]',
    );
    if (!shellControl) return;
    if (root.dataset.rdMutationPending === "true") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (shellControl.dataset.nx === "rd-rescan") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void rescanWorkbenchDevices(root, shellControl);
    }
  }, true);
  root.addEventListener("submit", (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = ev instanceof SubmitEvent && ev.submitter instanceof HTMLElement
      ? ev.submitter
      : null;
    if (form.matches('[data-rd-form="theme"]')) {
      const menu = form.closest<HTMLElement>("[data-rd-theme-menu]");
      if (!menu) return;
      ev.preventDefault();
      void submitThemeForm(form, menu, root, submitter);
    } else if (form.matches('[data-rd-form="device"]')) {
      ev.preventDefault();
      void submitDeviceForm(form, root, submitter);
    } else if (form.matches('[data-rd-form="identify"]')) {
      ev.preventDefault();
      void submitIdentifyForm(form, root, submitter);
    } else if (
      form.matches(
        '[data-rd-form="save"], [data-rd-form="play"], ' +
          '[data-rd-form="play-replace"], [data-rd-form="apply"], ' +
          '[data-rd-form="stop"], [data-rd-form="adopt"], ' +
          '[data-rd-form="discard"], [data-rd-form="capture-prepare"], ' +
          '[data-rd-form="capture-release"]',
      )
    ) {
      ev.preventDefault();
      void submitLifecycleForm(form, root, submitter);
    } else if (
      form.matches(
        '[data-rd-form="controller-add"], [data-rd-form="controller-move"], ' +
          '[data-rd-form="controller-remove"], [data-rd-form="controller-park"], ' +
          '[data-rd-form="controller-assign"], [data-rd-form="controller-socd"], ' +
          '[data-rd-form="controller-duplicate"], [data-rd-form="controller-undo"], ' +
          '[data-rd-form="bind-clear"], [data-rd-form="bind-clear-all"], ' +
          '[data-rd-form="key-clear"], [data-rd-form="blocking"], ' +
          '[data-rd-form="bind-turbo"], [data-rd-form="bind-toggle"], ' +
          '[data-rd-form="macro-toggle"], [data-rd-form="macro-new"], ' +
          '[data-rd-form="macro-delete"]',
      )
    ) {
      // Park and assign are ONE server transaction each (stash + remove +
      // compact; restore-or-fresh + seat), and the inspector's re-homed
      // nocturne verbs are each one shared-core POST — so every controller
      // verb rides the same single-post handler.
      ev.preventDefault();
      void submitControllerForm(form, root, submitter);
    }
  });
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const retry = target.closest<HTMLButtonElement>(
      '[data-nx="rd-refresh-retry"], [data-rd-live-retry]',
    );
    if (retry) {
      event.preventDefault();
      void retryWorkbenchStatus(root, retry);
      return;
    }
    if (target.closest("[data-rd-identify-cancel]")) void cancelIdentify(root);
  });
  window.addEventListener("keydown", guardIdentifyKey, true);
  window.addEventListener("keypress", guardIdentifyKey, true);
  if (!identifyLifecycleWired) {
    identifyLifecycleWired = true;
    window.addEventListener("pagehide", abandonIdentifyOnPageHide);
  }
  wireApplyRestartDialog(root);
}

/** Theme and Stage both repaint the complete served payload. Treat the whole
 * island as one mutation surface so an older refresh can never arrive last
 * and temporarily roll back the other verb's visible truth. */
const pendingMutationRoots = new WeakSet<HTMLElement>();
type SubmitControl = HTMLButtonElement | HTMLInputElement | HTMLSelectElement;

/** Every fetch-enhanced submit on the page — one selector, so the mutation
 *  lock can never miss a form type that joined later. The Player selects
 *  belong in it too: a change during a pending mutation would mint a ghost
 *  whose park verb the lock silently swallowed — the select must be as
 *  disabled as the submit it drives. */
const MUTATION_SUBMIT_SELECTOR = [
  "theme",
  "device",
  "identify",
  "controller-add",
  "controller-move",
  "controller-remove",
  "controller-park",
  "controller-assign",
  "controller-socd",
  "controller-duplicate",
  "controller-undo",
  "bind-clear",
  "bind-clear-all",
  "key-clear",
  "blocking",
  "bind-turbo",
  "bind-toggle",
  "macro-toggle",
  "macro-new",
  "macro-delete",
  "save",
  "play",
  "play-replace",
  "apply",
  "stop",
  "adopt",
  "discard",
  "capture-prepare",
  "capture-release",
]
  .flatMap((kind) => [
    `[data-rd-form="${kind}"] button[type="submit"]`,
    `[data-rd-form="${kind}"] input[type="submit"]`,
  ])
  .concat([
    "select.rd-ctrlplayer",
    '[data-nx="rd-shared-policy"]',
    '[data-nx="rd-dev-toggle"]',
    '[data-nx="rd-offline-remove"]',
    '[data-nx="rd-rescan"]',
    '[data-nx="rd-refresh-retry"]',
    "[data-rd-live-retry]",
  ])
  .join(", ");

async function retryWorkbenchStatus(
  root: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  if (
    root.dataset.rdMutationPending === "true" ||
    button.dataset.rdRetryPending === "true"
  ) return;
  const settled = button.textContent ?? "Retry";
  button.dataset.rdRetryPending = "true";
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  button.textContent = "Checking…";
  rdAnnounce("Checking workbench status…");
  try {
    await refresh("foreground");
    // EventSource owns reconnect cadence and `connect` refuses to create a
    // duplicate source. This only ensures a browser that failed before the
    // source was constructed gets another safe connection attempt.
    liveFeedback?.connect();
  } finally {
    const restoreFocus = actionStillOwnsFocus(button, button);
    if (!button.isConnected) return;
    delete button.dataset.rdRetryPending;
    button.removeAttribute("aria-busy");
    button.disabled = false;
    button.textContent = settled;
    if (!restoreFocus) return;
    const style = window.getComputedStyle(button);
    const visible = button.getClientRects().length > 0 && style.visibility !== "hidden";
    if (visible) {
      button.focus({ preventScroll: true });
    } else {
      root.querySelector<HTMLElement>(".rd-profile-sum")?.focus({ preventScroll: true });
    }
  }
}

function beginMutation(root: HTMLElement): SubmitControl[] | null {
  if (pendingMutationRoots.has(root)) return null;
  pendingMutationRoots.add(root);
  cancelActiveRefresh();
  root.dataset.rdMutationPending = "true";
  root.setAttribute("aria-busy", "true");
  const controls = Array.from(
    root.querySelectorAll<SubmitControl>(MUTATION_SUBMIT_SELECTOR),
  );
  controls.forEach((control) => {
    control.disabled = true;
  });
  return controls;
}

function endMutation(root: HTMLElement, controls: SubmitControl[]): void {
  delete root.dataset.rdMutationPending;
  root.removeAttribute("aria-busy");
  // A device card can be added from the still-usable picker while the
  // request is in flight. Include those newly mounted controls as well as
  // the original snapshot so none remain stuck disabled after the lock.
  const currentControls = root.querySelectorAll<SubmitControl>(MUTATION_SUBMIT_SELECTOR);
  new Set<SubmitControl>([...controls, ...currentControls]).forEach((control) => {
    const form = control.closest<HTMLFormElement>("form[data-rd-form]");
    const served = form ? redesignFormProductDisabled(form) : undefined;
    control.disabled = served ?? control.dataset.rdProductDisabled === "true";
  });
  pendingMutationRoots.delete(root);
}

/** Rescan is a foreground authority transaction, even though it writes no
 * product state. Giving it the same island lock means it can neither sample
 * before a POST commits and repaint afterward, nor start while such a POST is
 * pending. The generation coordinator remains the second line of defence. */
async function rescanWorkbenchDevices(
  root: HTMLElement,
  button: HTMLButtonElement,
): Promise<void> {
  const controls = beginMutation(root);
  if (!controls) return;
  const ownedFocus = actionStillOwnsFocus(button, button);
  const settledAriaLabel = button.getAttribute("aria-label");
  button.dataset.rdPending = "true";
  button.setAttribute("aria-busy", "true");
  button.textContent = "Rescanning…";
  button.setAttribute("aria-label", "Rescanning…");
  rdAnnounce("Rescanning connected devices.");
  let refreshed = false;
  try {
    refreshed = await refreshExact("foreground", true);
  } finally {
    if (button.isConnected) {
      delete button.dataset.rdPending;
      button.removeAttribute("aria-busy");
      button.textContent = "Rescan";
      if (settledAriaLabel === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", settledAriaLabel);
    }
    endMutation(root, controls);
    if (ownedFocus) {
      const current = root.querySelector<HTMLButtonElement>('[data-nx="rd-rescan"]');
      if (current?.isConnected && current.offsetParent !== null) {
        current.focus({ preventScroll: true });
      }
    }
  }
  const scan = refreshed ? latestDeviceScanStatus : null;
  if (!refreshed) {
    rdAnnounce("Device rescan could not finish. The last known list is still shown.");
  } else if (scan?.authoritative) {
    rdAnnounce("Connected devices refreshed.");
  } else if (scan?.usbAuthoritative || scan?.bluetoothAuthoritative) {
    const unavailable = [
      !scan.usbAuthoritative ? "USB" : "",
      !scan.bluetoothAuthoritative ? "Bluetooth" : "",
    ].filter(Boolean).join(" and ");
    rdAnnounce(
      `Device rescan was partial${unavailable ? `: ${unavailable} did not answer` : ""}.` +
        `${scan.line ? ` ${scan.line}` : " The last known list is still shown for unavailable connections."}`,
    );
  } else {
    rdAnnounce(
      `Device rescan could not confirm connected devices.` +
        `${scan?.line ? ` ${scan.line}` : " The last known list is still shown."}`,
    );
  }
}

function setDeviceMutationPending(
  root: HTMLElement,
  selector: string,
  action: "add" | "remove",
  pending: boolean,
): void {
  const controls = Array.from(
    root.querySelectorAll<HTMLButtonElement>(
      '[data-nx="rd-dev-toggle"], [data-nx="rd-offline-remove"]',
    ),
  ).filter((control) =>
    control.dataset.selector === selector ||
    control.closest<HTMLElement>(".rd-dev-node[data-selector]")?.dataset.selector === selector
  );
  for (const control of controls) {
    const label = control.matches('[data-nx="rd-dev-toggle"]')
      ? control.querySelector<HTMLElement>(".rd-dev-word")
      : control;
    if (pending) {
      control.dataset.rdPending = "true";
      control.setAttribute("aria-busy", "true");
      if (label) {
        label.dataset.rdSettledLabel = label.textContent ?? "";
        label.textContent = action === "add" ? "Adding…" : "Removing…";
      }
    } else {
      delete control.dataset.rdPending;
      control.removeAttribute("aria-busy");
      if (label?.dataset.rdSettledLabel !== undefined) {
        label.textContent = label.dataset.rdSettledLabel;
        delete label.dataset.rdSettledLabel;
      }
    }
  }
}

/** A delayed response must not steal focus from a modal or another canvas
 * control the user moved to while the request was in flight. Browsers may
 * move focus to body when the submitter becomes disabled, which still counts
 * as the original action owning the focus lifecycle. */
function actionStillOwnsFocus(owner: HTMLElement, submitter: HTMLElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === submitter || owner.contains(active);
}

type IdentifyUiState =
  | "idle"
  | "listening"
  | "cancelling"
  | "resolving"
  | "identified"
  | "cancelled"
  | "error";

function identifySurface(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-rd-identify]");
}

function setIdentifyUi(
  root: HTMLElement,
  state: IdentifyUiState,
  label: string,
  detail: string,
  cancelVisible = false,
): void {
  const surface = identifySurface(root);
  const status = surface?.querySelector<HTMLElement>("[data-rd-identify-status]");
  const heading = surface?.querySelector<HTMLElement>("[data-rd-identify-label]");
  const copy = surface?.querySelector<HTMLElement>("[data-rd-identify-detail]");
  const cancel = surface?.querySelector<HTMLButtonElement>("[data-rd-identify-cancel]");
  if (!status || !heading || !copy || !cancel) return;
  status.dataset.state = state;
  heading.textContent = label;
  copy.textContent = detail;
  cancel.hidden = !cancelVisible;
  cancel.disabled = state === "cancelling";
}

/** While the daemon is listening, the next key belongs to identification.
 * Disable every other picker verb and keep the modal mounted; otherwise Space
 * can toggle a focused row and a backdrop click can hide a transaction that
 * may still stage a board. */
function setIdentifyModalPending(root: HTMLElement, pending: boolean): void {
  const modal = root.querySelector<HTMLElement>(".rd-devmodal");
  if (!modal) return;
  if (pending) modal.dataset.rdIdentifyPending = "true";
  else delete modal.dataset.rdIdentifyPending;
  modal.querySelectorAll<HTMLButtonElement>(
    '[data-nx="rd-dev-toggle"], [data-nx="rd-devs-close"]',
  ).forEach((button) => {
    button.disabled = pending;
  });
}

function identifyIsPending(root: HTMLElement): boolean {
  return root.querySelector<HTMLElement>(".rd-devmodal")?.dataset.rdIdentifyPending === "true";
}

function stagedIdentifyRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    '.rd-devmodal [data-nx="rd-dev-toggle"][aria-current="true"]',
  ));
}

function stagedIdentifySelectors(root: HTMLElement): Set<string> {
  return new Set(
    stagedIdentifyRows(root)
      .map((row) => row.dataset.selector?.trim() ?? "")
      .filter(Boolean),
  );
}

function identifyRowForSelector(root: HTMLElement, selector: string): HTMLElement | null {
  return Array.from(
    root.querySelectorAll<HTMLElement>('.rd-devmodal [data-nx="rd-dev-toggle"]'),
  ).find((row) => row.dataset.selector === selector) ?? null;
}

/** A returned start response means Raw Input no longer owns the next key.
 * Retire that exact browser attempt before any authority refresh so a slow
 * repaint cannot expose a Cancel button for work the server already settled. */
function settleIdentifyListener(root: HTMLElement, controller: AbortController): void {
  if (identifyRequestController === controller) {
    identifyRequestController = null;
    identifyRequestAttempt = null;
  }
  setIdentifyModalPending(root, false);
}

/** A transport can disappear after the daemon commits the selection. Cancel
 * the nonce if it is still live, then read current authority before writing
 * any outcome copy. Even a successful refresh cannot prove which request
 * caused an unchanged row, so that case remains explicitly unconfirmed. */
async function recoverUnconfirmedIdentify(
  root: HTMLElement,
  attempt: string,
  previousSelectors: ReadonlySet<string>,
): Promise<boolean> {
  setIdentifyUi(
    root,
    "resolving",
    "Checking the current mapping source",
    "The listening response was interrupted. Confirming the server's current selection…",
  );
  try {
    await fetch("/redesign/device/identify/cancel", {
      method: "POST",
      body: new URLSearchParams({ attempt }),
      redirect: "follow",
    });
  } catch {
    // The foreground authority read below remains the customer-safe boundary.
  }

  if (!(await refresh())) {
    applyRedesignFlash(
      "error: the keyboard-listening outcome could not be confirmed — reload before trying again.",
    );
    setIdentifyUi(
      root,
      "error",
      "Identification outcome unknown",
      "Reload the workbench to confirm the current mapping source before trying again.",
    );
    return false;
  }

  const currentRows = stagedIdentifyRows(root);
  const addedRows = currentRows.filter((row) => {
    const selector = row.dataset.selector?.trim() ?? "";
    return selector && !previousSelectors.has(selector);
  });
  const addedName = addedRows.length === 1
    ? addedRows[0]?.querySelector<HTMLElement>(".n-dev-name")?.textContent?.trim()
    : "";
  applyRedesignFlash(
    "error: the keyboard-listening response was lost — review the current mapping sources before retrying.",
  );
  setIdentifyUi(
    root,
    "error",
    "Could not confirm the identification outcome",
    addedName
      ? `The workbench now includes ${addedName} as another source, but this interrupted request cannot prove what caused that change. Review the mapping-source list or reload before trying again.`
      : "Review the mapping-source list or reload before trying again.",
  );
  return false;
}

/** The physical key reaches the daemon independently of the browser event.
 * Prevent browser scrolling, focused-button activation and canvas shortcuts;
 * Escape is the one authored cancellation door. */
function guardIdentifyKey(event: KeyboardEvent): void {
  const root = redesignRoot;
  if (!root || !identifyIsPending(root)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "Escape" && event.type === "keydown") void cancelIdentify(root);
}

/** A long-lived identify POST outlives its document unless the exact attempt
 * is cancelled explicitly. Queue the cancellation through the browser's
 * navigation-safe channel before aborting the page-owned fetch; the nonce
 * makes duplicate or delayed delivery harmless to another tab's listener. */
function abandonIdentifyOnPageHide(): void {
  const controller = identifyRequestController;
  const attempt = identifyRequestAttempt;
  if (!controller || !attempt) return;
  const body = new URLSearchParams({ attempt });
  const queued = navigator.sendBeacon("/redesign/device/identify/cancel", body);
  if (!queued) {
    void fetch("/redesign/device/identify/cancel", {
      method: "POST",
      body,
      redirect: "manual",
      keepalive: true,
    }).catch(() => undefined);
  }
  // If this document is restored from the back-forward cache, its pending
  // request must not repaint as a generic network failure.
  identifyCancellationAccepted = true;
  identifyRequestController = null;
  identifyRequestAttempt = null;
  controller.abort();
}

function identifyErrorCopy(flash: string | null): string {
  return (flash ?? "No keyboard answered. Nothing changed.")
    .replace(/^error:\s*/i, "")
    .trim();
}

function showIdentifiedDevice(root: HTMLElement, selector: string): void {
  const row = identifyRowForSelector(root, selector);
  const name = row?.querySelector<HTMLElement>(".n-dev-name")?.textContent?.trim() ?? "";
  const identity = row?.querySelector<HTMLElement>(".rd-dev-identity")?.textContent?.trim() ?? "";
  setIdentifyUi(
    root,
    "identified",
    name ? `Identified ${name}` : "Keyboard identified",
    identity
      ? `${identity}. This exact connection is now an independent mapping source.`
      : "The exact connection that answered is now an independent mapping source.",
  );
  if (row) {
    row.classList.add("rd-row-pulse");
    window.setTimeout(() => row.classList.remove("rd-row-pulse"), 1400);
  }
}

async function performIdentifyCancellation(root: HTMLElement): Promise<boolean> {
  const controller = identifyRequestController;
  const attempt = identifyRequestAttempt;
  if (!controller || !attempt || !identifyIsPending(root)) return false;
  setIdentifyUi(
    root,
    "cancelling",
    "Cancelling identification",
    "Stopping only this keyboard-listening attempt…",
    true,
  );
  try {
    const response = await fetch("/redesign/device/identify/cancel", {
      method: "POST",
      body: new URLSearchParams({ attempt }),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`identify cancellation failed with ${response.status}`);
    // The original response may have won while this request was in flight.
    // It owns the already-painted outcome; a late cancellation response must
    // not roll a settled success back to "listening".
    if (
      identifyRequestController !== controller ||
      identifyRequestAttempt !== attempt ||
      !identifyIsPending(root)
    ) return false;
    const outcome = new URL(response.url).searchParams.get("flash");
    applyRedesignFlash(outcome);
    if (outcome === IDENTIFY_CANCELLED_FLASH) {
      identifyCancellationAccepted = true;
      setIdentifyUi(
        root,
        "cancelled",
        "Identification cancelled",
        "Nothing changed. You can start again whenever you are ready.",
      );
      controller.abort();
      return true;
    }
    // The server retired the generation before resolving a hit, so this is
    // not a cancellation failure: the original answer now owns the outcome.
    setIdentifyUi(
      root,
      "listening",
      "A keyboard already answered",
      "Finishing the exact-device check…",
    );
    return false;
  } catch {
    if (identifyCancellationAccepted) return true;
    applyRedesignFlash(
      "error: cancellation could not reach ksx studio. Identification is still listening.",
    );
    setIdentifyUi(
      root,
      "listening",
      "Still listening for one key",
      "Cancellation could not reach ksx. Press one key, or try Cancel again.",
      true,
    );
    root.querySelector<HTMLButtonElement>("[data-rd-identify-cancel]")?.focus({
      preventScroll: true,
    });
    return false;
  }
}

async function cancelIdentify(root: HTMLElement): Promise<void> {
  if (identifyCancellationTask) {
    await identifyCancellationTask;
    return;
  }
  const task = performIdentifyCancellation(root);
  identifyCancellationTask = task;
  try {
    await task;
  } finally {
    if (identifyCancellationTask === task) identifyCancellationTask = null;
  }
}

async function submitIdentifyForm(
  form: HTMLFormElement,
  root: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  const submits = beginMutation(root);
  if (!submits) return;
  const owner = identifySurface(root) ?? form;
  const controller = new AbortController();
  const words = crypto.getRandomValues(new Uint32Array(4));
  const attempt = Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
  identifyRequestController = controller;
  identifyRequestAttempt = attempt;
  identifyCancellationAccepted = false;
  let identified = false;
  const previousSelectors = stagedIdentifySelectors(root);
  setIdentifyModalPending(root, true);
  setIdentifyUi(
    root,
    "listening",
    "Listening for one key",
    "Press one key on the exact keyboard or encoder to add it as an independent mapping source. Esc cancels.",
    true,
  );
  root.querySelector<HTMLElement>("[data-rd-identify-status]")?.focus({
    preventScroll: true,
  });
  try {
    const response = await fetch(form.action, {
      method: "POST",
      body: new URLSearchParams({ attempt }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`identify request failed with ${response.status}`);
    const resultUrl = new URL(response.url);
    const outcome = resultUrl.searchParams.get("flash");
    const answeredSelector = resultUrl.searchParams.get("identified_selector")?.trim() ?? "";
    const answeredName = answeredSelector
      ? identifyRowForSelector(root, answeredSelector)
        ?.querySelector<HTMLElement>(".n-dev-name")
        ?.textContent?.trim() ?? ""
      : "";
    if (outcome !== IDENTIFY_OK_FLASH) {
      // Cancellation owns the authoritative outcome for this exact nonce.
      // The held start request is allowed to observe the server-side stop and
      // return its generic failure before the cancel response reaches this
      // browser. Keep the attempt live until that in-flight arbitration has
      // answered; retiring it here would make the later, exact "cancelled"
      // response fail performIdentifyCancellation's ownership check.
      const cancelling = identifyCancellationTask;
      if (cancelling && await cancelling) return;
      settleIdentifyListener(root, controller);
      if (outcome === IDENTIFY_CANCELLED_FLASH) {
        applyRedesignFlash(outcome);
        setIdentifyUi(
          root,
          "cancelled",
          "Identification cancelled",
          "Nothing changed. You can start again whenever you are ready.",
        );
        return;
      }
      applyRedesignFlash(outcome);
      setIdentifyUi(root, "error", "No keyboard selected", identifyErrorCopy(outcome));
      return;
    }
    settleIdentifyListener(root, controller);
    applyRedesignFlash(outcome);
    setIdentifyUi(
      root,
      "resolving",
      "Keyboard answered",
      "Confirming the exact connection is now an independent mapping source…",
    );
    if (!(await refresh())) {
      applyRedesignFlash(
        "error: the keyboard answered, but the workbench could not refresh — reload to confirm the mapping source.",
      );
      setIdentifyUi(
        root,
        "error",
        "Keyboard answered — refresh needed",
        "Reload the workbench to confirm which exact connection became a mapping source.",
      );
      return;
    }
    const answeredRow = answeredSelector
      ? identifyRowForSelector(root, answeredSelector)
      : null;
    if (!answeredSelector || answeredRow?.getAttribute("aria-current") !== "true") {
      applyRedesignFlash(
        "error: the keyboard answered, but its exact connection is not in the current mapping sources — review the device list.",
      );
      setIdentifyUi(
        root,
        "error",
        "Keyboard answered — source not confirmed",
        answeredSelector
          ? `${answeredName || "The exact connection"} answered this attempt, but it is no longer present in the mapping-source list. Rescan before mapping.`
          : "The server did not disclose which exact connection answered. Reload and review the mapping-source list before mapping.",
      );
      return;
    }
    identified = true;
    showIdentifiedDevice(root, answeredSelector);
  } catch {
    if (controller.signal.aborted && identifyCancellationAccepted) return;
    const cancelling = identifyCancellationTask;
    if (cancelling && await cancelling) return;
    settleIdentifyListener(root, controller);
    identified = await recoverUnconfirmedIdentify(root, attempt, previousSelectors);
  } finally {
    if (identifyRequestController === controller) {
      identifyRequestController = null;
      identifyRequestAttempt = null;
    }
    setIdentifyModalPending(root, false);
    const restoreFocus = actionStillOwnsFocus(owner, submitter);
    endMutation(root, submits);
    if (!restoreFocus) return;
    if (identified) {
      root.querySelector<HTMLElement>("[data-rd-identify-status]")?.focus({
        preventScroll: true,
      });
    } else {
      form.querySelector<HTMLElement>('button[type="submit"]')?.focus({ preventScroll: true });
    }
  }
}

async function submitThemeForm(
  form: HTMLFormElement,
  menu: HTMLElement,
  root: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  const submits = beginMutation(root);
  if (!submits) return;
  const summary = menu.querySelector<HTMLElement>("[data-rd-theme-summary]");
  let completed = false;
  try {
    const body = new URLSearchParams();
    new FormData(form, submitter).forEach((value, key) => {
      if (typeof value === "string") body.append(key, value);
    });
    const res = await fetch(form.action, {
      method: "POST",
      body,
      redirect: "follow", // 303 → GET /redesign?flash=…; the outcome rides res.url
    });
    if (!res.ok) throw new Error(`theme request failed with ${res.status}`);
    applyRedesignFlash(new URL(res.url).searchParams.get("flash"));
    if (!(await refresh())) {
      applyRedesignFlash(
        "error: theme was sent, but the workbench could not refresh — reload to confirm.",
      );
      return;
    }
    completed = true;
  } catch {
    applyRedesignFlash("error: request failed — is ksx studio still running?");
  } finally {
    const restoreFocus = actionStillOwnsFocus(menu, submitter);
    endMutation(root, submits);
    if (completed) {
      // A fold that acted closes itself, but focus must remain at the verb
      // that opened it rather than falling through to the document/canvas.
      menu.removeAttribute("open");
      if (restoreFocus) summary?.focus();
    } else if (restoreFocus && submitter) {
      // A failed request leaves the choices visible for retry.
      submitter.focus();
    }
  }
}

async function submitDeviceForm(
  form: HTMLFormElement,
  root: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  const submits = beginMutation(root);
  if (!submits) return;
  const card = form.closest<HTMLElement>(".rd-dev-node");
  let refreshed = false;
  try {
    const body = new URLSearchParams();
    new FormData(form, submitter).forEach((value, key) => {
      if (typeof value === "string") body.append(key, value);
    });
    const res = await fetch(form.action, {
      method: "POST",
      body,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`device request failed with ${res.status}`);
    applyRedesignFlash(new URL(res.url).searchParams.get("flash"));
    if (!(await refresh())) {
      applyRedesignFlash(
        "error: the device request completed, but the workbench could not refresh — reload to confirm.",
      );
      return;
    }
    refreshed = true;
  } catch {
    applyRedesignFlash("error: request failed — is ksx studio still running?");
  } finally {
    const focusOwner = card ?? form;
    const restoreFocus = actionStillOwnsFocus(focusOwner, submitter);
    endMutation(root, submits);
    if (!restoreFocus) return;
    if (!card?.isConnected) {
      // The authoritative scan may lose the initiating board while Stage is
      // in flight. Its detached button cannot receive focus, so return to the
      // durable workbench entry point instead of dropping the keyboard user
      // on <body>.
      root.querySelector<HTMLElement>('[data-nx="rd-devs-open"]')?.focus({
        preventScroll: true,
      });
      return;
    }
    if (refreshed && card?.dataset.staged !== "false") {
      // A successful stage hides the verb; an unknown provider disables it.
      // In either state, keep keyboard focus on the durable card/status,
      // never its hidden or product-disabled submitter.
      card?.focus({ preventScroll: true });
    } else {
      // A refusal or failed repaint leaves the Stage verb available to retry.
      submitter?.focus({ preventScroll: true });
    }
  }
}

function selectMutationSource(action: "add" | "remove", selector: string): void {
  const url = new URL(window.location.href);
  if (action === "add") {
    url.searchParams.set("source", selector);
    url.searchParams.delete("macro");
  } else if (url.searchParams.get("source") === selector) {
    url.searchParams.delete("source");
    url.searchParams.delete("macro");
  }
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${query ? `?${query}` : ""}`);
}

function pickerDeviceIsOnCanvas(root: HTMLElement, selector: string): boolean {
  const authorityButton = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-nx="rd-dev-toggle"][data-selector]',
    ),
  ).find((button) => button.dataset.selector === selector);
  return authorityButton?.getAttribute("aria-current") === "true";
}

/** Canvas picker membership is a real staged-device verb. It shares the page
 * mutation lock and response-generation coordinator with forms, while the
 * island remains the sole owner of geometry and canvas persistence. */
async function mutateCanvasDevice(
  action: "add" | "remove",
  row: RdDeviceRowView,
  options: RedesignDeviceMutationOptions,
  root: HTMLElement,
): Promise<boolean> {
  const focusOwner = document.activeElement instanceof HTMLElement && (
      document.activeElement.dataset.selector === row.selector ||
      document.activeElement.closest<HTMLElement>(".rd-dev-node[data-selector]")?.dataset
          .selector === row.selector
    )
    ? document.activeElement
    : null;
  const submits = beginMutation(root);
  if (!submits) return false;
  setDeviceMutationPending(root, row.selector, action, true);
  let committed = false;
  try {
    const body = new URLSearchParams({ selector: row.selector });
    if (action === "add") {
      body.set("alias", row.alias);
      body.set("label", row.label);
    } else {
      // The island passes the exact signal snapshot behind the clicked row.
      // Do not scrape authority tokens from DOM attributes: the SSR compiler
      // may legitimately omit internal metadata, and an adopted row can be
      // replaced while focus remains stable. Reuse this byte-for-byte body if
      // the backend discovers a concurrent route and requests confirmation.
      body.set("expected_revision", options.expectedRevision?.trim() ?? "");
      body.set(
        "expected_source_revision",
        options.expectedSourceRevision?.trim() ?? "",
      );
      if (options.confirmRemove) body.set("confirm_remove", "yes");
    }
    const endpoint = action === "add" ? "/redesign/device" : "/redesign/device/remove";
    const send = () => fetch(endpoint, { method: "POST", body, redirect: "follow" });
    let res = await send();
    if (!res.ok) throw new Error(`device ${action} failed with ${res.status}`);
    let flash = new URL(res.url).searchParams.get("flash");
    if (action === "remove" && flash === DEVICE_REMOVE_CONFIRM_FLASH) {
      const accepted = window.confirm(
        `Remove ${row.label} from the canvas and mapping draft?\n\n` +
          "Its controller mappings will be removed. Controllers and other keyboards stay unchanged.",
      );
      if (accepted) {
        // Mutate only the consent bit. Selector and both revision tokens stay
        // byte-for-byte identical to the original guarded attempt.
        body.set("confirm_remove", "yes");
        res = await send();
        if (!res.ok) throw new Error(`device ${action} failed with ${res.status}`);
        flash = new URL(res.url).searchParams.get("flash");
      } else {
        flash = "Removal cancelled. Nothing changed.";
      }
    }
    const responseClaimsCommit = Boolean(
      flash?.trim() && !flash.trim().toLowerCase().startsWith("error:"),
    ) && flash !== "Removal cancelled. Nothing changed.";
    applyRedesignFlash(flash);
    const refreshed = await refresh();
    // Production redirects carry an explicit, allowlisted outcome. A proxy,
    // harness, or future API may instead acknowledge with a plain 2xx. Such a
    // response is only a provisional success: prove the requested membership
    // from the refreshed authority before mounting or removing a board.
    committed = responseClaimsCommit || (
      !flash?.trim() &&
      refreshed &&
      pickerDeviceIsOnCanvas(root, row.selector) === (action === "add")
    );
    if (committed) selectMutationSource(action, row.selector);
    if (!refreshed && committed) {
      applyRedesignFlash(
        `error: the device was ${action === "add" ? "added" : "removed"}, but the workbench could not refresh — reload to confirm.`,
      );
    }
  } catch {
    applyRedesignFlash("error: request failed — is ksx studio still running?");
  } finally {
    const restoreFocus = Boolean(focusOwner && actionStillOwnsFocus(focusOwner, focusOwner));
    setDeviceMutationPending(root, row.selector, action, false);
    endMutation(root, submits);
    if (restoreFocus) {
      const replacement = Array.from(
        root.querySelectorAll<HTMLElement>(
          '[data-nx="rd-dev-toggle"], [data-nx="rd-offline-remove"]',
        ),
      ).find((control) => {
        const matches = control.dataset.selector === row.selector ||
          control.closest<HTMLElement>(".rd-dev-node[data-selector]")?.dataset.selector ===
            row.selector;
        return matches && renderedLifecycleTarget(control);
      });
      const trayClose = root.querySelector<HTMLElement>(
        '.rd-devmodal:not([hidden]) [data-nx="rd-devs-close"]',
      );
      const target = replacement ?? (renderedLifecycleTarget(trayClose) ? trayClose : null);
      target?.focus({ preventScroll: true });
    }
  }
  return committed;
}

/** One handler for the three controller verbs (add / move / remove): the
 *  daemon owns every consequence — numbering, ceilings, availability — so
 *  the whole client answer is flash + full repaint. The picker deliberately
 *  stays open after an add: staging several controllers in one visit is the
 *  point. A card's verbs are rebuilt by the repaint, so when the submitter
 *  does not survive it, focus lands on the durable opener instead of a
 *  detached node. */
async function submitControllerForm(
  form: HTMLFormElement,
  root: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  const sharedPolicy = form.matches('[data-rd-form="blocking"]');
  const submittedGhost =
    (form.elements.namedItem("ghost") as HTMLInputElement | null)?.value?.trim() ?? "";
  const assignGhost = form.matches('[data-rd-form="controller-assign"]')
    ? submittedGhost
    : "";
  const parkGhost = form.matches('[data-rd-form="controller-park"]')
    ? submittedGhost
    : "";
  const parkTargetRevision = parkGhost
    ? (form.elements.namedItem("expected_target_revision") as HTMLInputElement | null)?.value
        ?.trim() ?? ""
    : "";
  let parkConfirmed = false;
  let parkOutcomeUnknown = false;
  let parkRollbackScheduled = false;
  let parkResponseReceived = false;
  // The controller surface submits before it persists the optimistic ghost:
  // persisting first replaces and detaches the live card/form. Queueing the
  // inverse therefore makes every early refusal (including the shared page
  // mutation lock) run after that same change gesture has finished parking.
  const rollbackOptimisticPark = (): void => {
    if (!parkGhost || parkConfirmed || parkRollbackScheduled) return;
    parkRollbackScheduled = true;
    window.queueMicrotask(() => unparkController(parkGhost));
  };
  const submits = beginMutation(root);
  if (!submits) {
    rollbackOptimisticPark();
    return;
  }
  const owner = sharedPolicy
    ? form.closest<HTMLElement>("[data-rd-source-controls]") ?? form
    : form.closest<HTMLElement>(".rd-ctrlmodal-panel, .rd-ctrl-node") ?? form;
  try {
    // Forma may reconcile a list row without carrying an <input>'s value
    // property across the repaint. The form's durable row metadata is the
    // submission source of truth, so a second rapid Add can never post blank
    // persona/default fields after the first Add refreshed the catalog.
    if (form.matches('[data-rd-form="controller-add"]')) {
      const fields = [
        ["persona", "persona"],
        ["preset", "preset"],
        ["layout", "layout"],
        ["source", "source"],
        ["expected_revision", "expectedRevision"],
        ["expected_source_revision", "expectedSourceRevision"],
      ] as const;
      for (const [name, dataName] of fields) {
        const input = form.elements.namedItem(name) as HTMLInputElement | null;
        if (input) input.value = form.dataset[dataName] ?? input.value;
      }
    }
    const body = new URLSearchParams();
    new FormData(form, submitter).forEach((value, key) => {
      if (typeof value === "string") body.append(key, value);
    });
    const res = await fetch(form.action, {
      method: "POST",
      body,
      redirect: "follow",
    });
    parkResponseReceived = true;
    if (!res.ok) {
      rollbackOptimisticPark();
      throw new Error(`controller request failed with ${res.status}`);
    }
    const outcome = new URL(res.url).searchParams.get("flash");
    const outcomeSucceeded = Boolean(
      outcome?.trim() && !outcome.trim().toLowerCase().startsWith("error:"),
    );
    // A successful redirect is the park commit boundary. Keep the ghost even
    // if the subsequent repaint fails: the daemon has already removed the
    // live slot and is holding its resurrection material under this id.
    parkConfirmed = Boolean(parkGhost) && outcomeSucceeded;
    if (parkGhost && !outcomeSucceeded) rollbackOptimisticPark();
    applyRedesignFlash(outcome);
    if (!(await refresh())) {
      applyRedesignFlash(
        "error: the controller request completed, but the workbench could not refresh — reload to confirm.",
      );
    }
    // A re-slot SUCCEEDED exactly when the server dropped the ghost's stash
    // entry — the id leaving the refreshed `parked_held` is the structural
    // signal, never a sentence comparison. The error-prefix guard keeps a
    // REFUSED fresh-fallback (which was never held) parked for another try.
    if (assignGhost && outcomeSucceeded && !redesignGhostHeld(assignGhost)) {
      unparkController(assignGhost);
    }
  } catch {
    if (parkGhost && !parkResponseReceived) {
      // A rejected fetch is ambiguous: the POST may have committed and only
      // its response may have been lost. Reconcile before deciding whether
      // the recoverable browser ghost is duplicate state or the sole handle
      // to a server-held parked snapshot.
      const reconciled = await refresh();
      if (reconciled && redesignGhostHeld(parkGhost)) {
        parkConfirmed = true;
        applyRedesignFlash(
          "Controller parked. Its response was interrupted, but refreshed daemon state confirmed it.",
        );
      } else {
        const originalTargetStillLive = Boolean(
          reconciled && parkTargetRevision &&
            Array.from(
              root.querySelectorAll<HTMLInputElement>(
                'form[data-rd-form="controller-park"] input[name="expected_target_revision"]',
              ),
            ).some((input) => input.value.trim() === parkTargetRevision),
        );
        if (originalTargetStillLive) {
          rollbackOptimisticPark();
          applyRedesignFlash("error: request failed — is ksx studio still running?");
        } else {
          // No authoritative repaint, or the exact live target also changed:
          // preserve recovery material rather than risk silently deleting the
          // only handle to a park that may have committed.
          parkOutcomeUnknown = true;
          applyRedesignFlash(
            "error: The park response was lost and its outcome could not be confirmed. The parked card was kept for recovery; reload before discarding it.",
          );
        }
      }
    } else {
      rollbackOptimisticPark();
      applyRedesignFlash("error: request failed — is ksx studio still running?");
    }
  } finally {
    // Defensive coverage for future non-throwing exit paths added above.
    if (parkGhost && !parkConfirmed && !parkOutcomeUnknown) rollbackOptimisticPark();
    const restoreFocus = actionStillOwnsFocus(owner, submitter);
    endMutation(root, submits);
    if (sharedPolicy) {
      returnSharedPolicyEditor(restoreFocus);
    } else if (restoreFocus) {
      if (
        submitter?.isConnected &&
        !(submitter as HTMLButtonElement | HTMLInputElement).disabled
      ) {
        submitter.focus({ preventScroll: true });
      } else {
        root
          .querySelector<HTMLElement>('[data-nx="rd-ctrls-open"]')
          ?.focus({ preventScroll: true });
      }
    }
  }
}

let applyDialogReturnFocus: HTMLElement | null = null;

function applyRestartDialog(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-rd-apply-dialog]");
}

function dialogFocusable(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
        'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((candidate) => !candidate.hidden && candidate.offsetParent !== null);
}

function closeApplyRestartDialog(root: HTMLElement, restore = true): void {
  const backdrop = applyRestartDialog(root);
  if (!backdrop || backdrop.hidden) return;
  backdrop.hidden = true;
  delete backdrop.dataset.rdApplyAuthority;
  const revision = backdrop.querySelector<HTMLInputElement>("[data-rd-apply-revision]");
  if (revision) revision.value = "";
  const target = applyDialogReturnFocus;
  applyDialogReturnFocus = null;
  if (restore && target?.isConnected) target.focus({ preventScroll: true });
}

function openApplyRestartDialog(
  root: HTMLElement,
  message: string,
  returnFocus: HTMLElement | null,
  authority: string,
  revision: string,
): void {
  const backdrop = applyRestartDialog(root);
  if (!backdrop) return;
  const copy = backdrop.querySelector<HTMLElement>("[data-rd-apply-message]");
  if (copy) {
    copy.textContent = message.trim() ||
      "The running controller structure differs from this draft.";
  }
  applyDialogReturnFocus = returnFocus;
  backdrop.dataset.rdApplyAuthority = authority;
  const revisionField = backdrop.querySelector<HTMLInputElement>("[data-rd-apply-revision]");
  if (revisionField) revisionField.value = revision;
  backdrop.hidden = false;
  backdrop.querySelector<HTMLElement>(".rd-restart-dialog")?.focus({ preventScroll: true });
}

/** Focus containment and restoration for Apply's client-only structural
 * restart decision. The ordinary form path remains available without JS. */
function wireApplyRestartDialog(root: HTMLElement): void {
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("[data-rd-apply-cancel]")) return;
    closeApplyRestartDialog(root);
  });
  root.addEventListener("keydown", (event) => {
    const dialog = applyRestartDialog(root);
    if (!dialog || dialog.hidden || !dialog.contains(event.target as Node)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeApplyRestartDialog(root);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogFocusable(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.querySelector<HTMLElement>(".rd-restart-dialog")?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!focusable.includes(active as HTMLElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

type LifecycleFormKind =
  | "save"
  | "play"
  | "play-replace"
  | "apply"
  | "stop"
  | "adopt"
  | "discard"
  | "capture-prepare"
  | "capture-release";

function lifecycleSubmitButton(
  form: HTMLFormElement,
  submitter: HTMLElement | null,
): HTMLButtonElement | null {
  if (submitter instanceof HTMLButtonElement) return submitter;
  return form.querySelector<HTMLButtonElement>('button[type="submit"]');
}

/** Swap real child nodes, not generated CSS copy, so the visible label and
 * accessible name tell the same pending truth. Payload refreshes may replace
 * the old button; a detached node is harmless and the served replacement is
 * already back in its settled state. */
const lifecycleSettledAriaLabels = new WeakMap<HTMLButtonElement, string | null>();

function setLifecyclePending(button: HTMLButtonElement | null, pending: boolean): void {
  if (!button) return;
  const settled = button.querySelector<HTMLElement>(".rd-action-label");
  const pendingLabel = button.querySelector<HTMLElement>(".rd-action-pending");
  if (!settled || !pendingLabel) return;
  settled.hidden = pending;
  pendingLabel.hidden = !pending;
  button.toggleAttribute("data-rd-pending", pending);
  if (pending) {
    if (!lifecycleSettledAriaLabels.has(button)) {
      lifecycleSettledAriaLabels.set(button, button.getAttribute("aria-label"));
    }
    // Some exact-device actions have a richer settled aria-label than their
    // short painted copy. While pending, however, the visible status is the
    // complete action: expose that same text, then restore the exact original
    // attribute (including its absence) when the transaction settles.
    button.setAttribute("aria-label", pendingLabel.textContent?.trim() || "Working…");
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
    if (lifecycleSettledAriaLabels.has(button)) {
      const ariaLabel = lifecycleSettledAriaLabels.get(button) ?? null;
      if (ariaLabel === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", ariaLabel);
      lifecycleSettledAriaLabels.delete(button);
    }
  }
}

interface CaptureFocusIdentity {
  selector: string;
  instance: string;
}

function renderedLifecycleTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target.closest("[hidden], [inert]")) return false;
  const style = window.getComputedStyle(target);
  return target.getClientRects().length > 0 && style.display !== "none" &&
    style.visibility !== "hidden";
}

function lifecycleFocusTarget(
  root: HTMLElement,
  kind: LifecycleFormKind,
  capture: CaptureFocusIdentity | null = null,
): HTMLElement | null {
  const visibleAction = (formKind: "play" | "stop") =>
    Array.from(
      root.querySelectorAll<HTMLElement>(
        `[data-rd-form="${formKind}"] button:not([disabled])`,
      ),
    ).find((button) => button.offsetParent !== null) ?? null;
  if (kind === "play" || kind === "play-replace") {
    return visibleAction("stop") ?? root.querySelector<HTMLElement>(".rd-profile-sum");
  }
  if (kind === "stop") {
    return visibleAction("play") ?? root.querySelector<HTMLElement>(".rd-profile-sum");
  }
  if (capture && (kind === "capture-prepare" || kind === "capture-release")) {
    const instance = capture.instance.toLowerCase();
    const board = Array.from(
      root.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]"),
    ).find((item) =>
      item.dataset.selector === capture.selector &&
      item.dataset.staged === "true" &&
      (item.dataset.sourceInstance ?? "").toLowerCase() === instance
    );
    const summary = board?.querySelector<HTMLElement>("[data-rd-device-capture] > summary") ?? null;
    if (renderedLifecycleTarget(summary)) return summary;
    const held = Array.from(
      root.querySelectorAll<HTMLElement>(".rd-held-row[data-held-selector]"),
    ).find((row) =>
      row.dataset.heldSelector === capture.selector &&
      (row.dataset.heldInstance ?? "").toLowerCase() === instance
    );
    if (renderedLifecycleTarget(held ?? null)) return held!;
    const review = root.querySelector<HTMLElement>('[data-nx="rd-review-recovery"]');
    if (renderedLifecycleTarget(review)) return review;
    return root.querySelector<HTMLElement>(".rd-profile-sum");
  }
  return root.querySelector<HTMLElement>(".rd-profile-sum");
}

/** One lifecycle transaction owns the whole island. Apply is the single
 * structured exception because a structural refusal must present the
 * daemon's exact reason and an explicit Replace-session decision. */
async function submitLifecycleForm(
  form: HTMLFormElement,
  root: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  const kind = form.dataset.rdForm as LifecycleFormKind | undefined;
  if (!kind) return;
  const activeAtStart = document.activeElement;
  const startedWithFocus = activeAtStart === submitter || Boolean(activeAtStart && form.contains(activeAtStart));
  const requestedRevision = form.querySelector<HTMLInputElement>('input[name="expected_revision"]')
    ?.value.trim() ?? "";
  const requestedCapture = kind === "capture-prepare" || kind === "capture-release"
    ? {
        selector: form.querySelector<HTMLInputElement>('input[name="expected_selector"]')
          ?.value.trim() ?? "",
        instance: form.querySelector<HTMLInputElement>('input[name="instance_id"]')
          ?.value.trim() ?? "",
      }
    : null;
  const requestedApplyAuthority = kind === "apply"
    ? applyAuthority(redesignOperationalState())
    : "";
  const submits = beginMutation(root);
  if (!submits) return;
  const pendingButton = lifecycleSubmitButton(form, submitter);
  setLifecyclePending(pendingButton, true);
  let actionSucceeded = false;
  let refreshed = false;
  let restartMessage = "";
  try {
    if (kind === "apply") {
      const body = new URLSearchParams();
      new FormData(form, submitter).forEach((value, key) => {
        if (typeof value === "string") body.append(key, value);
      });
      const res = await fetch("/redesign/api/apply", {
        method: "POST",
        headers: { accept: "application/json" },
        body,
      });
      if (!res.ok) throw new Error(`apply request failed with ${res.status}`);
      const outcome = (await res.json()) as {
        done: boolean;
        code?: string;
        message?: string;
        flash?: string;
      };
      if (!outcome.done && outcome.code === "needs-restart") {
        restartMessage = outcome.message ?? "";
      } else {
        applyRedesignFlash(outcome.flash ?? null);
        actionSucceeded = outcome.done === true;
      }
    } else {
      const body = new URLSearchParams();
      new FormData(form, submitter).forEach((value, key) => {
        if (typeof value === "string") body.append(key, value);
      });
      const res = await fetch(form.action, {
        method: "POST",
        body,
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`lifecycle request failed with ${res.status}`);
      const outcome = new URL(res.url).searchParams.get("flash");
      applyRedesignFlash(outcome);
      actionSucceeded = Boolean(outcome && !outcome.startsWith("error"));
    }

    // A needs-restart refusal changes no state; refreshing it is still useful
    // because another client may have advanced the draft during the request.
    refreshed = await refresh();
    if (!refreshed) {
      applyRedesignFlash(
        "error: the action completed, but the workbench could not refresh — reload to confirm.",
      );
      actionSucceeded = false;
    } else if (
      actionSucceeded &&
      (kind === "apply" || kind === "play" || kind === "play-replace")
    ) {
      // Reconcile ran inside refresh; advance the conservative client latch
      // only after the authoritative verb and payload both succeeded.
      liveFeedback?.acceptCurrentRevision();
    }
    if (restartMessage) {
      if (!refreshed) {
        // The refresh failure above already carries the only truthful
        // recovery. It proves no newer authority, so do not relabel it as an
        // authority change—and never open a replacement decision from it.
        restartMessage = "";
      } else {
        const current = redesignOperationalState();
        const restartStillValid = Boolean(
          requestedRevision &&
          current?.draft_revision === requestedRevision &&
          current.apply?.allowed === true &&
          requestedApplyAuthority === applyAuthority(current),
        );
        if (!restartStillValid) {
          restartMessage = "";
          applyRedesignFlash(
            "The draft or running session changed while Apply was checked. Review the latest setup before replacing Play.",
          );
        }
      }
    }
  } catch {
    applyRedesignFlash("error: request failed — is ksx studio still running?");
  } finally {
    const restoreFocus = startedWithFocus && actionStillOwnsFocus(form, submitter);
    setLifecyclePending(pendingButton, false);
    endMutation(root, submits);
    if (restartMessage) {
      openApplyRestartDialog(
        root,
        restartMessage,
        submitter,
        requestedApplyAuthority,
        requestedRevision,
      );
      return;
    }
    if (kind === "play-replace" && actionSucceeded) {
      closeApplyRestartDialog(root, false);
    }
    if (actionSucceeded && (kind === "adopt" || kind === "discard")) {
      const profile = root.querySelector<HTMLDetailsElement>("[data-rd-profile-menu]");
      if (profile?.open) profile.open = false;
    }
    if (!restoreFocus) return;
    const retryTarget = submitter?.isConnected && submitter.offsetParent !== null &&
        !("disabled" in submitter && submitter.disabled === true)
      ? submitter
      : null;
    const target = actionSucceeded
      ? lifecycleFocusTarget(root, kind, requestedCapture)
      : retryTarget ?? lifecycleFocusTarget(root, kind, requestedCapture);
    target?.focus({ preventScroll: true });
  }
}

/** Hydration must start the action signals from the already-sanitized SSR
 *  flash. It intentionally is not part of /api/redesign: polling is not an
 *  action and must not replay old feedback. */
function seedRenderedFlash(root: HTMLElement): void {
  const rendered = root.querySelector<HTMLElement>(".rd-flash");
  // Forma's SSR markers can contribute non-visible text during adoption.
  // The server-owned visibility class is the authoritative indication that
  // this request actually carried an allowlisted action result.
  if (!rendered || rendered.classList.contains("none")) return;
  const line = rendered?.textContent?.trim();
  if (!line) return;
  applyRedesignFlash(rendered.classList.contains("err") ? `error: ${line}` : line);
}

// Ledger #5 order: the served signals hold the server's values BEFORE the
// island tree builds, or adoption clobbers SSR. The canvas adopts on the
// next frame — the served skeleton exists only after the island mounts.
activateIslands({
  RedesignIsland: (el) => {
    redesignRoot = el;
    liveFeedback?.dispose();
    liveFeedback = createRedesignLiveFeedback({
      root: () => el,
      selectedSlot: redesignSelectedSlot,
      setPathLive: redesignSetLivePaths,
      announce: rdAnnounce,
    });
    el.addEventListener("ksx:redesign-source-surface-change", () => {
      liveFeedback?.invalidateTargets();
    });
    el.addEventListener("ksx:redesign-flow-anchors-change", () => {
      liveFeedback?.invalidateTargets();
    });
    const seed = embeddedPayload<RedesignPayload>();
    if (seed) applyPayload(seed);
    seedRenderedFlash(el);
    // The island asks for another slot's panel through this (selection →
    // ?slot merge → refetch) without ever owning fetch.
    setRedesignRefresh((options) => refresh("foreground", options?.fresh === true));
    setRedesignDeviceMutation((action, row, options) =>
      mutateCanvasDevice(action, row, options ?? {}, el)
    );
    // The mapper (learn/assign/bind) — page truths as ports, the entry's
    // mutation gate shared so a bind commit can never interleave with an
    // in-flight form verb.
    mapperWire({
      root: () => el,
      flash: applyRedesignFlash,
      refresh,
      announce: rdAnnounce,
      learnSource: redesignLearnSource,
      pads: redesignPads,
      selectedSlot: redesignSelectedSlot,
      controlsFor: redesignControlsFor,
      beginMutation: () => beginMutation(el),
      endMutation: (token) => endMutation(el, token as never),
    });
    // The macro step editor (its dialog, draft, and save) — same ports.
    macWire({ root: () => el, refresh });
    startBackgroundPoll(el);
    redesignWire(el);
    wireForms(el);
    window.requestAnimationFrame(() => {
      initRedesignCanvas(el);
      liveFeedback?.invalidateTargets();
      liveFeedback?.connect();
    });
    // A no-JS POST landed us on ?flash=…: the server already painted the
    // line; strip the query so a manual reload does not replay feedback for
    // an action nobody just took.
    const query = new URLSearchParams(window.location.search);
    if (query.has("flash")) {
      query.delete("flash");
      const clean = query.toString();
      window.history.replaceState(null, "", clean === "" ? "/redesign" : `/redesign?${clean}`);
    }
    return RedesignIsland();
  },
});
