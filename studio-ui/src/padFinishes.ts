import {
  DS4_PREMIUM_SHELL_TONE,
  DS4_PREMIUM_VARIANTS,
  type Ds4PremiumVariantSlug,
} from "./ds4PremiumGeometry";
import {
  DUALSENSE_PREMIUM_SHELL_TONE,
  DUALSENSE_PREMIUM_VARIANTS,
  type DualSensePremiumVariantSlug,
} from "./dualSensePremiumGeometry";
import {
  SWITCH_PRO_PREMIUM_SHELL_TONE,
  SWITCH_PRO_PREMIUM_VARIANTS,
  type SwitchProPremiumVariantSlug,
} from "./switchProPremiumGeometry";
import {
  XBOX_SERIES_PREMIUM_SHELL_TONE,
  XBOX_SERIES_PREMIUM_VARIANTS,
  type XboxSeriesPremiumVariantSlug,
} from "./xboxSeriesPremiumGeometry";

// ── Controller finishes — the browser-kept paint choice per controller ─────
// Extracted from the retired Nocturne island so the redesign owns one focused
// implementation. The historical localStorage keys remain intentionally: a
// hard cutover must preserve a controller's chosen finish instead of silently
// resetting presentation state. The daemon owns nothing here — a finish is
// presentation chrome keyed to the controller's preset identity
// (`padStoreKeys`' rule).

const DS4_VARIANT_STORE = "ksx-nocturne-ds4-variants1";
const DS4_VARIANT_SLUGS = new Set<string>(DS4_PREMIUM_VARIANTS.map((variant) => variant.slug));
let ds4Variants: Record<string, Ds4PremiumVariantSlug> = {};
const CONTROLLER_FINISH_STORE = "ksx-nocturne-controller-finishes1";

export type PremiumControllerFamily = "ps5" | "switchpro" | "xboxseries";
export type PremiumControllerVariantSlug =
  | DualSensePremiumVariantSlug
  | SwitchProPremiumVariantSlug
  | XboxSeriesPremiumVariantSlug;
export type PremiumControllerVariant = {
  readonly slug: PremiumControllerVariantSlug;
  readonly label: string;
  readonly swatch: string;
  readonly gradient: string;
  readonly tones: Readonly<Record<string, string>>;
};
export type PremiumControllerConfig = {
  readonly label: string;
  readonly selector: string;
  readonly variantAttribute: string;
  readonly shellTone: string;
  readonly variants: readonly PremiumControllerVariant[];
};

const PREMIUM_CONTROLLER_CONFIGS: Record<PremiumControllerFamily, PremiumControllerConfig> = {
  ps5: {
    label: "DualSense",
    selector: "svg.dualsensepremium",
    variantAttribute: "data-dualsense-variant",
    shellTone: DUALSENSE_PREMIUM_SHELL_TONE,
    variants: DUALSENSE_PREMIUM_VARIANTS,
  },
  switchpro: {
    label: "Switch Pro",
    selector: "svg.switchpropremium",
    variantAttribute: "data-switchpro-variant",
    shellTone: SWITCH_PRO_PREMIUM_SHELL_TONE,
    variants: SWITCH_PRO_PREMIUM_VARIANTS,
  },
  xboxseries: {
    label: "Xbox Series",
    selector: "svg.xboxseriespremium",
    variantAttribute: "data-xboxseries-variant",
    shellTone: XBOX_SERIES_PREMIUM_SHELL_TONE,
    variants: XBOX_SERIES_PREMIUM_VARIANTS,
  },
};

let controllerFinishes: Record<string, PremiumControllerVariantSlug> = {};

export function loadDs4Variants(): void {
  try {
    const raw = window.localStorage.getItem(DS4_VARIANT_STORE);
    const saved = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const clean: Record<string, Ds4PremiumVariantSlug> = {};
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === "string" && DS4_VARIANT_SLUGS.has(value)) {
        clean[key] = value as Ds4PremiumVariantSlug;
      }
    }
    ds4Variants = clean;
  } catch {
    ds4Variants = {};
  }
}

function saveDs4Variants(): void {
  try {
    window.localStorage.setItem(DS4_VARIANT_STORE, JSON.stringify(ds4Variants));
  } catch {
    // A controller finish is chrome; blocked storage only makes it temporary.
  }
}

/** The saved DS4 finish for one controller identity, if any. */
export function ds4VariantFor(storeKey: string): Ds4PremiumVariantSlug | undefined {
  return ds4Variants[storeKey];
}

/** Repaint one clone through the four source-authored color palettes. The
 *  geometry never changes: every finish writes the same ten CSS paint tones,
 *  with only the main shell upgraded to the shared Studio gradient server. */
export function applyDs4Variant(
  svg: SVGSVGElement,
  controls: HTMLElement,
  storeKey: string,
  slug: Ds4PremiumVariantSlug,
  persist: boolean,
): void {
  const variant = DS4_PREMIUM_VARIANTS.find((item) => item.slug === slug) ?? DS4_PREMIUM_VARIANTS[0];
  for (const [name, value] of Object.entries(variant.tones)) svg.style.setProperty(name, value);
  svg.style.setProperty(DS4_PREMIUM_SHELL_TONE, `url(#${variant.gradient})`);
  svg.dataset.ds4Variant = variant.slug;
  for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>("button[data-ds4-variant]"))) {
    button.setAttribute("aria-pressed", String(button.dataset.ds4Variant === variant.slug));
  }
  if (persist) {
    ds4Variants[storeKey] = variant.slug;
    saveDs4Variants();
  }
}

export function premiumControllerConfig(family: string): PremiumControllerConfig | null {
  return Object.prototype.hasOwnProperty.call(PREMIUM_CONTROLLER_CONFIGS, family)
    ? PREMIUM_CONTROLLER_CONFIGS[family as PremiumControllerFamily]
    : null;
}

function controllerFinishKey(family: PremiumControllerFamily, storeKey: string): string {
  return family + ":" + storeKey;
}

export function loadControllerFinishes(): void {
  try {
    const raw = window.localStorage.getItem(CONTROLLER_FINISH_STORE);
    const saved = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const clean: Record<string, PremiumControllerVariantSlug> = {};
    for (const [key, value] of Object.entries(saved)) {
      const separator = key.indexOf(":");
      const family = separator > 0 ? key.slice(0, separator) : "";
      const config = premiumControllerConfig(family);
      if (config && typeof value === "string" && config.variants.some((variant) => variant.slug === value)) {
        clean[key] = value as PremiumControllerVariantSlug;
      }
    }
    controllerFinishes = clean;
  } catch {
    controllerFinishes = {};
  }
}

function saveControllerFinishes(): void {
  try {
    window.localStorage.setItem(CONTROLLER_FINISH_STORE, JSON.stringify(controllerFinishes));
  } catch {
    // A finish is visual chrome; blocked storage only makes it temporary.
  }
}

/** The saved premium finish for one controller identity, if any. */
export function controllerFinishFor(
  family: PremiumControllerFamily,
  storeKey: string,
): PremiumControllerVariantSlug | undefined {
  return controllerFinishes[controllerFinishKey(family, storeKey)];
}

export function applyPremiumControllerVariant(
  svg: SVGSVGElement,
  controls: HTMLElement,
  family: PremiumControllerFamily,
  storeKey: string,
  slug: PremiumControllerVariantSlug,
  persist: boolean,
): void {
  const config = PREMIUM_CONTROLLER_CONFIGS[family];
  const variant = config.variants.find((item) => item.slug === slug) ?? config.variants[0];
  for (const [name, value] of Object.entries(variant.tones)) svg.style.setProperty(name, value);
  svg.style.setProperty(config.shellTone, `url(#${variant.gradient})`);
  svg.setAttribute("data-controller-variant", variant.slug);
  svg.setAttribute(config.variantAttribute, variant.slug);
  for (const button of Array.from(controls.querySelectorAll<HTMLButtonElement>("button[data-controller-variant]"))) {
    button.setAttribute("aria-pressed", String(button.dataset.controllerVariant === variant.slug));
  }
  if (persist) {
    controllerFinishes[controllerFinishKey(family, storeKey)] = variant.slug;
    saveControllerFinishes();
  }
}
