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
async function refresh(): Promise<boolean> {
  try {
    const res = await fetch("/api/redesign", { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    applyRedesign((await res.json()) as RedesignPayload);
    return true;
  } catch {
    // The flash already said what failed; the page keeps its last truth.
    return false;
  }
}

/** Fetch-enhance the theme forms only. Other redesign widgets own their own
 *  verbs and must never silently inherit this menu's close/flash/refresh
 *  lifecycle as the workbench grows. With JavaScript off these still POST +
 *  303 + full reload; with it on the outcome and payload repaint in place. */
function wireForms(root: HTMLElement): void {
  root.addEventListener("submit", (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-rd-form="theme"]')) return;
    const menu = form.closest<HTMLElement>(".rd-themed");
    if (!menu) return;
    ev.preventDefault();
    const submitter = ev instanceof SubmitEvent && ev.submitter instanceof HTMLElement
      ? ev.submitter
      : null;
    void submitThemeForm(form, menu, submitter);
  });
}

/** The picker is one mutation surface even though progressive enhancement
 *  gives every row its own form. Lock the whole fold so two different theme
 *  choices cannot race their writes and repaint responses. */
const pendingThemeMenus = new WeakSet<HTMLElement>();

async function submitThemeForm(
  form: HTMLFormElement,
  menu: HTMLElement,
  submitter: HTMLElement | null,
): Promise<void> {
  if (pendingThemeMenus.has(menu)) return;
  pendingThemeMenus.add(menu);
  const submits = Array.from(
    menu.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"], input[type="submit"]',
    ),
  );
  const summary = menu.querySelector<HTMLElement>(".rd-theme-sum");
  let completed = false;
  submits.forEach((control) => {
    control.disabled = true;
  });
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
    submits.forEach((control) => {
      control.disabled = false;
    });
    pendingThemeMenus.delete(menu);
    if (completed) {
      // A fold that acted closes itself, but focus must remain at the verb
      // that opened it rather than falling through to the document/canvas.
      menu.removeAttribute("open");
      summary?.focus();
    } else if (submitter) {
      // A failed request leaves the choices visible for retry.
      submitter.focus();
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
