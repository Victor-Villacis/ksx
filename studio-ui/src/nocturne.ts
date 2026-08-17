import { activateIslands } from "@getforma/core";
import { fetchJSON } from "@getforma/core/http";

// The compiler's island-first entry pattern (parseEntryPoint): the imported
// `*Page` component NOT in the activateIslands registry is the SSR root.
// NocturnePage never runs in the browser — esbuild tree-shakes it — but this
// import is what anchors IR emission. Do not remove it.
import { NocturnePage } from "./NocturnePage";
import {
  applyFlash,
  applyNocturne,
  applyNocturneUnreachable,
  NocturneIsland,
  nocturneLiveConnect,
  nocturneWire,
  setNocturnePoll,
  type NocturnePayload,
} from "./NocturneIsland";

void NocturnePage; // compile-time anchor only (see above)

/** Same cadence as every structure poller: the draft and the machine change
 *  on human actions, not at display rate. */
const POLL_MS = 2000;

async function poll(): Promise<void> {
  try {
    applyNocturne(await fetchJSON<NocturnePayload>("/api/nocturne"));
  } catch {
    applyNocturneUnreachable();
  }
}

/** Fetch-enhance the plain-HTML forms (the devices.ts pattern). With
 *  JavaScript off they POST + 303 + full reload, which is the baseline this
 *  page is built on; with it on, the submit goes through fetch, the outcome
 *  is read out of the redirect's ?flash= query, and the panes refresh in
 *  place — so the row you just acted on is still under the cursor. Delegated
 *  on the island root, because the lists are reconciled and a per-form
 *  listener would die with its row. */
function wireForms(root: HTMLElement): void {
  root.addEventListener("submit", (ev) => {
    const form = ev.target as HTMLFormElement | null;
    if (!form) return;
    if (form.method.toLowerCase() === "get") {
      // The one GET form is Rescan: a fresh read IS the poll.
      ev.preventDefault();
      void poll();
      return;
    }
    if (form.method.toLowerCase() !== "post") return;
    ev.preventDefault();
    void submitForm(form);
  });
}

/** A UAC-backed mutation (capture prepare/release) must not be launched
 *  twice by a double click while the first permission prompt is open. */
const pendingForms = new WeakSet<HTMLFormElement>();

async function submitForm(form: HTMLFormElement): Promise<void> {
  if (pendingForms.has(form)) return;
  pendingForms.add(form);
  const submits = Array.from(
    form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"], input[type="submit"]',
    ),
  );
  submits.forEach((control) => {
    control.disabled = true;
  });
  try {
    const body = new URLSearchParams();
    new FormData(form).forEach((value, key) => {
      if (typeof value === "string") body.append(key, value);
    });
    const res = await fetch(form.action, {
      method: "POST",
      body,
      redirect: "follow", // 303 → GET /nocturne?flash=…; the outcome rides res.url
    });
    applyFlash(new URL(res.url).searchParams.get("flash"));
    // A consent fold that just acted closes itself: the outcome line above
    // and the refreshed switch state are the answer now.
    form.closest("details")?.removeAttribute("open");
  } catch {
    applyFlash("error: request failed — is ksx studio still running?");
  } finally {
    pendingForms.delete(form);
    submits.forEach((control) => {
      if (control.isConnected) control.disabled = false;
    });
  }
  void poll();
}

/** The SOURCE payload the server embedded (render.rs `PAYLOAD_SCRIPT_ID`) —
 *  not the island's `props` argument, which carries the RENDERED SLOT VALUES.
 *  See status.ts for the longer note (dogfood ledger #8/#19). */
function embeddedPayload<T>(): T | null {
  const el = document.getElementById("__ksx-payload");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

// /nocturne carries one migrated REAL section (the keyboard pane — device
// pick, identify, split-or-freeze, prepared-for-play) beside the design
// proof's placeholder demos. Ledger #5 order: the served signals hold the
// server's values BEFORE the island tree builds, or adoption clobbers SSR.
activateIslands({
  NocturneIsland: (el) => {
    const seed = embeddedPayload<NocturnePayload>();
    if (seed) applyNocturne(seed);
    nocturneWire(el);
    wireForms(el);
    setNocturnePoll(() => void poll());
    nocturneLiveConnect();
    window.setInterval(() => void poll(), POLL_MS);
    // A no-JS POST landed us on ?flash=…: the server already painted the
    // line; strip the query so a manual reload does not replay feedback for
    // an action nobody just took.
    const query = new URLSearchParams(window.location.search);
    if (query.get("flash")) {
      query.delete("flash");
      const clean = query.toString();
      window.history.replaceState(null, "", clean === "" ? "/nocturne" : `/nocturne?${clean}`);
    }
    return NocturneIsland();
  },
});
