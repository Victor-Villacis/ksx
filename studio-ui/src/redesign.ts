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
  redesignWire,
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
async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/redesign", { headers: { accept: "application/json" } });
    if (!res.ok) return;
    applyRedesign((await res.json()) as RedesignPayload);
  } catch {
    // The flash already said what failed; the page keeps its last truth.
  }
}

/** Fetch-enhance the plain-HTML forms (the nocturne.ts pattern). With
 *  JavaScript off they POST + 303 + full reload, which is the baseline this
 *  page is built on; with it on, the submit goes through fetch, the outcome
 *  is read out of the redirect's ?flash= query, and the payload refreshes in
 *  place. Delegated on the island root, because the theme rows are
 *  reconciled and a per-form listener would die with its row. */
function wireForms(root: HTMLElement): void {
  root.addEventListener("submit", (ev) => {
    const form = ev.target as HTMLFormElement | null;
    if (!form || form.method.toLowerCase() !== "post") return;
    ev.preventDefault();
    void submitForm(form);
  });
}

/** A double click must not launch the same verb twice while the first
 *  round-trip is in flight (the nocturne guard, kept with the copy). */
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
      redirect: "follow", // 303 → GET /redesign?flash=…; the outcome rides res.url
    });
    applyRedesignFlash(new URL(res.url).searchParams.get("flash"));
    // A fold that just acted closes itself: the outcome line and the moved
    // marking are the answer now (the nocturne consent-fold convention).
    form.closest("details")?.removeAttribute("open");
  } catch {
    applyRedesignFlash("error: request failed — is ksx studio still running?");
  } finally {
    pendingForms.delete(form);
    submits.forEach((control) => {
      control.disabled = false;
    });
  }
  void refresh();
}

// Ledger #5 order: the served signals hold the server's values BEFORE the
// island tree builds, or adoption clobbers SSR. The canvas adopts on the
// next frame — the served skeleton exists only after the island mounts.
activateIslands({
  RedesignIsland: (el) => {
    const seed = embeddedPayload<RedesignPayload>();
    if (seed) applyRedesign(seed);
    redesignWire(el);
    wireForms(el);
    window.requestAnimationFrame(() => {
      initRedesignCanvas(el);
    });
    // A no-JS POST landed us on ?flash=…: the server already painted the
    // line; strip the query so a manual reload does not replay feedback for
    // an action nobody just took.
    const query = new URLSearchParams(window.location.search);
    if (query.get("flash")) {
      query.delete("flash");
      const clean = query.toString();
      window.history.replaceState(null, "", clean === "" ? "/redesign" : `/redesign?${clean}`);
    }
    return RedesignIsland();
  },
});
