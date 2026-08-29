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
  RedesignIsland,
  redesignGhostHeld,
  redesignWire,
  setRedesignRefresh,
  unparkController,
  type RedesignPayload,
} from "./RedesignIsland";

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

/** One fresh copy of the served payload — the fetch-submit layer's repaint.
 *  No interval poller on this page yet: the canvas is client state, and the
 *  seam's fields change on human actions, so a refresh after each verb is
 *  enough until a transplant brings live data. */
async function refresh(): Promise<boolean> {
  try {
    // The selected controller rides the URL (the nocturne `?slot=` door),
    // so a refresh serves the panel the canvas selection is looking at.
    const slot = new URLSearchParams(window.location.search).get("slot");
    const url = slot ? `/api/redesign?slot=${encodeURIComponent(slot)}` : "/api/redesign";
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    applyRedesign((await res.json()) as RedesignPayload);
    return true;
  } catch {
    // The flash already said what failed; the page keeps its last truth.
    return false;
  }
}

/** Fetch-enhance only explicitly typed redesign forms. Future widgets must
 *  opt into a lifecycle instead of silently inheriting Theme's close/focus
 *  behavior. With JavaScript off these remain ordinary POST + 303 forms;
 *  with it on, the outcome and served payload repaint in place. */
function wireForms(root: HTMLElement): void {
  root.addEventListener("submit", (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = ev instanceof SubmitEvent && ev.submitter instanceof HTMLElement
      ? ev.submitter
      : null;
    if (form.matches('[data-rd-form="theme"]')) {
      const menu = form.closest<HTMLElement>(".rd-themed");
      if (!menu) return;
      ev.preventDefault();
      void submitThemeForm(form, menu, root, submitter);
    } else if (form.matches('[data-rd-form="device"]')) {
      ev.preventDefault();
      void submitDeviceForm(form, root, submitter);
    } else if (
      form.matches(
        '[data-rd-form="controller-add"], [data-rd-form="controller-move"], ' +
          '[data-rd-form="controller-remove"], [data-rd-form="controller-park"], ' +
          '[data-rd-form="controller-assign"], [data-rd-form="controller-socd"], ' +
          '[data-rd-form="controller-duplicate"], [data-rd-form="controller-undo"], ' +
          '[data-rd-form="bind-clear"], [data-rd-form="bind-clear-all"], ' +
          '[data-rd-form="key-clear"], [data-rd-form="blocking"], ' +
          '[data-rd-form="bind-turbo"], [data-rd-form="bind-toggle"]',
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
]
  .flatMap((kind) => [
    `[data-rd-form="${kind}"] button[type="submit"]`,
    `[data-rd-form="${kind}"] input[type="submit"]`,
  ])
  .concat(["select.rd-ctrlplayer"])
  .join(", ");

function beginMutation(root: HTMLElement): SubmitControl[] | null {
  if (pendingMutationRoots.has(root)) return null;
  pendingMutationRoots.add(root);
  root.dataset.rdMutationPending = "true";
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
  // A device card can be added from the still-usable picker while the
  // request is in flight. Include those newly mounted controls as well as
  // the original snapshot so none remain stuck disabled after the lock.
  const currentControls = root.querySelectorAll<SubmitControl>(MUTATION_SUBMIT_SELECTOR);
  new Set<SubmitControl>([...controls, ...currentControls]).forEach((control) => {
    control.disabled = control.dataset.rdProductDisabled === "true";
  });
  pendingMutationRoots.delete(root);
}

/** A delayed response must not steal focus from a modal or another canvas
 * control the user moved to while the request was in flight. Browsers may
 * move focus to body when the submitter becomes disabled, which still counts
 * as the original action owning the focus lifecycle. */
function actionStillOwnsFocus(owner: HTMLElement, submitter: HTMLElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === submitter || owner.contains(active);
}

async function submitThemeForm(
  form: HTMLFormElement,
  menu: HTMLElement,
  root: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  const submits = beginMutation(root);
  if (!submits) return;
  const summary = menu.querySelector<HTMLElement>(".rd-theme-sum");
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
  const submits = beginMutation(root);
  if (!submits) return;
  const owner = form.closest<HTMLElement>(".rd-ctrlmodal-panel, .rd-ctrl-node") ?? form;
  // An assign form names the ghost it re-slots; a successful assign retires
  // that ghost from the arrangement store.
  const ghost = form.matches('[data-rd-form="controller-assign"]')
    ? (form.elements.namedItem("ghost") as HTMLInputElement | null)?.value ?? ""
    : "";
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
    if (!res.ok) throw new Error(`controller request failed with ${res.status}`);
    const outcome = new URL(res.url).searchParams.get("flash");
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
    if (ghost && outcome && !outcome.startsWith("error") && !redesignGhostHeld(ghost)) {
      unparkController(ghost);
    }
  } catch {
    applyRedesignFlash("error: request failed — is ksx studio still running?");
  } finally {
    const restoreFocus = actionStillOwnsFocus(owner, submitter);
    endMutation(root, submits);
    if (restoreFocus) {
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
    const seed = embeddedPayload<RedesignPayload>();
    if (seed) applyRedesign(seed);
    seedRenderedFlash(el);
    // The island asks for another slot's panel through this (selection →
    // ?slot merge → refetch) without ever owning fetch.
    setRedesignRefresh(refresh);
    redesignWire(el);
    wireForms(el);
    window.requestAnimationFrame(() => {
      initRedesignCanvas(el);
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
