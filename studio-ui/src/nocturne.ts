import { activateIslands } from "@getforma/core";

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
  restoreNocturneFilter,
  scheduleKbFit,
  setNocturnePoll,
  type NocturnePayload,
} from "./NocturneIsland";

void NocturnePage; // compile-time anchor only (see above)

/** Same cadence as every structure poller: the draft and the machine change
 *  on human actions, not at display rate. */
const POLL_MS = 2000;

/** The last applied body, verbatim. An idle page's polls come back byte
 *  identical, and skipping the apply then costs ~50 signal writes and every
 *  list's key walk — the cheapest work is the work not done. */
let lastBody = "";

async function poll(): Promise<void> {
  // A hidden tab does not need fresh paint; visibilitychange below polls
  // the moment it returns.
  if (document.hidden) return;
  // The poller echoes the page's own selection, so the payload it copies is
  // the one this URL's SSR would paint (the workspace's rule).
  const slot = new URLSearchParams(window.location.search).get("slot");
  const url = slot ? `/api/nocturne?slot=${encodeURIComponent(slot)}` : "/api/nocturne";
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.text();
    if (body === lastBody) return;
    lastBody = body;
    applyNocturne(JSON.parse(body) as NocturnePayload);
  } catch {
    // Recovery must re-apply even an identical payload.
    lastBody = "";
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
    // Unconditionally: a createShow'd dialog UNMOUNTS when applyFlash closes
    // it, but its tree is CACHED and returns on the next open — a button
    // skipped here because it was disconnected came back permanently
    // disabled (the second Create-a-controller silently did nothing until a
    // full reload). Setting `disabled` on a detached node is harmless.
    submits.forEach((control) => {
      control.disabled = false;
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
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void poll();
    });
    // The filter input and the board exist only after the island mounts:
    // restore ?q= and run the first fit on the next frame.
    window.requestAnimationFrame(() => {
      restoreNocturneFilter();
      scheduleKbFit();
    });
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
