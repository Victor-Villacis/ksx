import { h } from "@getforma/core";
import {
  Ds4PremiumButtonHooks,
  Ds4PremiumDepth,
  Ds4PremiumGeometry,
} from "./ds4PremiumGeometry";

/** Hybrid DualShock 4 (ViGEm PlayStation) master. Funky Designs' CC0
 * geometry supplies the real product detail; our MIT/app semantic layer
 * supplies L2/R2, exact mapper hooks and key callouts. All layers share
 * this one SVG and coordinate box. Extracted from the retired Nocturne
 * island so the redesign clones one authoritative drawing. */
export function Ds4PremiumPadArt() {
  return (
            h(
              "svg",
              {
                class: "wspad ds4a ds4premium",
                viewBox: "-28 -18 696 550",
                preserveAspectRatio: "xMidYMid meet",
                "data-ds4-variant": "jet-black",
                "aria-hidden": "true",
                focusable: "false",
              },
              h(
                "g",
                { class: "ds4premium-body" },
                h(
                  "g",
                  { class: "ds4premium-trigger-bridges" },
                  h("path", { class: "ds4premium-trigger-bridge", d: "M96 77 C109 68 151 68 164 78 L166 123 C143 120 116 120 90 126 L90 96 C90 87 92 82 96 77 Z" }),
                  h("path", { class: "ds4premium-trigger-bridge", d: "M544 77 C531 68 489 68 476 78 L474 123 C497 120 524 120 550 126 L550 96 C550 87 548 82 544 77 Z" }),
                ),
                h(
                  "g",
                  { class: "ds4premium-paid", transform: "matrix(0.1684210526 0 0 0.1684210526 0 105)" },
                  h(Ds4PremiumDepth, null),
                  h(Ds4PremiumGeometry, null),
                  // The 40 KB source dot-grid becomes one shared pattern.
                  h("path", { class: "ds4premium-touch-overlay", d: "M1355.79,842.942c-49.66,0 -89.98,-40.32 -89.98,-89.98l0,-612.415c0,-10.354 8.39,-18.748 18.75,-18.748l1230.88,0c10.36,0 18.75,8.394 18.75,18.748l0,612.415c0,49.66 -40.32,89.98 -89.98,89.98l-1088.42,0Z" }),
                ),
              ),
              // Two app-authored L2 zones plus 23 exact duplicates of the
              // paid drawing's whole controls. The paid duplicates carry the
              // same matrix as the art, so hover borders cannot drift.
              h(
                "g",
                { class: "ds4premium-hooks" },
                h("path", { "data-fn": "lt", class: "ds4premium-hook", d: "M167.27,80.69l-2.79-35.54c-1.25-15.98-14.77-28.21-30.8-27.85-13.24.3-24.75,9.19-28.38,21.93L93.72,79.86c-.77,2.71,1.26,5.4,4.08,5.4h65.24c2.47,0,4.42-2.11,4.23-4.57Z", fill: "transparent", "vector-effect": "non-scaling-stroke" }),
                h("path", { "data-fn": "rt", class: "ds4premium-hook", d: "M472.73,80.69l2.79-35.54c1.25-15.98,14.77-28.21,30.8-27.85,13.24.3,24.75,9.19,28.38,21.93l11.58,40.63c.77,2.71-1.26,5.4-4.08,5.4h-65.24c-2.47,0-4.42-2.11-4.23-4.57Z", fill: "transparent", "vector-effect": "non-scaling-stroke" }),
                h(Ds4PremiumButtonHooks, null),
                h("path", { "data-fn": "lt", class: "ds4free-hook", d: "M167.27,80.69l-2.79-35.54c-1.25-15.98-14.77-28.21-30.8-27.85-13.24.3-24.75,9.19-28.38,21.93L93.72,79.86c-.77,2.71,1.26,5.4,4.08,5.4h65.24c2.47,0,4.42-2.11,4.23-4.57Z", fill: "transparent" }),
                h("path", { "data-fn": "rt", class: "ds4free-hook", d: "M472.73,80.69l2.79-35.54c1.25-15.98,14.77-28.21,30.8-27.85,13.24.3,24.75,9.19,28.38,21.93l11.58,40.63c.77,2.71-1.26,5.4-4.08,5.4h-65.24c-2.47,0-4.42-2.11-4.23-4.57Z", fill: "transparent" }),
                h("path", { "data-fn": "lb", class: "ds4free-hook", d: "M165.32,123.06v-3.76c0-3.2-2.11-6.02-5.17-6.96-31.09-9.5-55.53-1.1-65.02,3.2-2.6,1.18-4.28,3.76-4.28,6.62v3.34s38.5-2.96,74.48-2.44Z", fill: "transparent" }),
                h("path", { "data-fn": "rb", class: "ds4free-hook", d: "M549.16,125.5v-3.34c0-2.86-1.68-5.44-4.28-6.62-9.49-4.3-33.93-12.7-65.02-3.2-3.06.94-5.17,3.75-5.17,6.96v3.76s34.84-.67,74.48,2.44Z", fill: "transparent" }),
                h("rect", { "data-fn": "back", class: "ds4free-hook", x: "183", y: "141", width: "22", height: "39", rx: "10", fill: "transparent" }),
                h("rect", { "data-fn": "start", class: "ds4free-hook", x: "435", y: "141", width: "22", height: "39", rx: "10", fill: "transparent" }),
                h("path", { "data-fn": "dpad.up", class: "ds4free-hook", d: "M140.7,184.19v6.44c0,5.03-1.96,9.87-5.46,13.49l-7.64,7.89c-3,3.09-8,2.99-10.87-.22l-6.95-7.79c-3.17-3.55-4.92-8.14-4.92-12.9v-6.9c0-6.43,5.21-11.64,11.64-11.64h12.57c6.43,0,11.64,5.21,11.64,11.64Z", fill: "transparent" }),
                h("path", { "data-fn": "dpad.right", class: "ds4free-hook", d: "M163.28,242.61h-6.44c-5.03,0-9.87-1.96-13.49-5.46l-7.89-7.64c-3.09-3-2.99-8,.22-10.87l7.79-6.95c3.55-3.17,8.14-4.92,12.9-4.92h6.9c6.43,0,11.64,5.21,11.64,11.64v12.57c0,6.43-5.21,11.64-11.64,11.64Z", fill: "transparent" }),
                h("path", { "data-fn": "dpad.down", class: "ds4free-hook", d: "M104.86,265.19v-6.44c0-5.03,1.96-9.87,5.46-13.49l7.64-7.89c3-3.09,8-2.99,10.87.22l6.95,7.79c3.17,3.55,4.92,8.14,4.92,12.9v6.9c0,6.43-5.21,11.64-11.64,11.64h-12.57c-6.43,0-11.64-5.21-11.64-11.64Z", fill: "transparent" }),
                h("path", { "data-fn": "dpad.left", class: "ds4free-hook", d: "M82.28,206.77h6.44c5.03,0,9.87,1.96,13.49,5.46l7.89,7.64c3.09,3,2.99,8-.22,10.87l-7.79,6.95c-3.55,3.17-8.14,4.92-12.9,4.92h-6.9c-6.43,0-11.64-5.21-11.64-11.64v-12.57c0-6.43,5.21-11.64,11.64-11.64Z", fill: "transparent" }),
                // y=triangle, b=circle, a=cross, x=square.
                h("circle", { "data-fn": "y", class: "ds4free-hook", cx: "517.22", cy: "178.98", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "b", class: "ds4free-hook", cx: "563.04", cy: "224.8", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "a", class: "ds4free-hook", cx: "517.22", cy: "270.62", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "x", class: "ds4free-hook", cx: "471.4", cy: "224.8", r: "22", fill: "transparent" }),
                h("circle", { "data-fn": "guide", class: "ds4free-hook", cx: "320.16", cy: "314.85", r: "17", fill: "transparent" }),
                h("circle", { "data-fn": "lthumb", class: "ds4free-hook", cx: "219.94", cy: "314.85", r: "24", fill: "transparent" }),
                h("circle", { "data-fn": "ly.max", class: "ds4free-hook", cx: "219.94", cy: "280", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "ly.min", class: "ds4free-hook", cx: "219.94", cy: "350", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "lx.min", class: "ds4free-hook", cx: "185", cy: "314.85", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "lx.max", class: "ds4free-hook", cx: "255", cy: "314.85", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "rthumb", class: "ds4free-hook", cx: "420.06", cy: "314.85", r: "24", fill: "transparent" }),
                h("circle", { "data-fn": "ry.max", class: "ds4free-hook", cx: "420.06", cy: "280", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "ry.min", class: "ds4free-hook", cx: "420.06", cy: "350", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "rx.min", class: "ds4free-hook", cx: "385", cy: "314.85", r: "13", fill: "transparent" }),
                h("circle", { "data-fn": "rx.max", class: "ds4free-hook", cx: "455", cy: "314.85", r: "13", fill: "transparent" }),
              ),
              // The free source intentionally has no retail face symbols or
              // lightbar; this app-owned dressing supplies those details.
              h(
                "g",
                { class: "ds4free-dressing" },
                h("path", { class: "ds4free-grip-shade", d: "M18 328 C8 372 5 433 27 470 C43 497 75 504 99 491 C119 480 133 457 143 429 C126 449 107 460 84 463 C52 466 29 443 24 410 C20 378 24 349 32 320 Z" }),
                h("path", { class: "ds4free-grip-shade", d: "M622 328 C632 372 635 433 613 470 C597 497 565 504 541 491 C521 480 507 457 497 429 C514 449 533 460 556 463 C588 466 611 443 616 410 C620 378 616 349 608 320 Z" }),
                h("path", { class: "ds4free-touch-texture", d: "M419.35,234.87v-102.38c0-2.12-1.73-3.85-3.85-3.85h-191.01c-2.12,0-3.85,1.73-3.85,3.85v102.38c0,4.13,3.36,7.5,7.5,7.5h183.71c4.13,0,7.5-3.36,7.5-7.5Z" }),
                h("path", { class: "ds4free-lightbar", d: "M235 131 Q320 119 405 131" }),
                h("path", { class: "ds4free-touch-sheen", d: "M235 142 Q320 132 405 142" }),
                h("path", { class: "ds4free-dpad-mark", d: "M122.78 179 l-6.2 10.5 h12.4 Z" }),
                h("path", { class: "ds4free-dpad-mark", d: "M168.3 224.69 l-10.5 -6.2 v12.4 Z" }),
                h("path", { class: "ds4free-dpad-mark", d: "M122.78 270.2 l-6.2 -10.5 h12.4 Z" }),
                h("path", { class: "ds4free-dpad-mark", d: "M77.3 224.69 l10.5 -6.2 v12.4 Z" }),
                h("rect", { class: "ds4free-face-mark ds4free-square-mark", x: "463.2", y: "216.6", width: "16.4", height: "16.4", rx: "1" }),
                h("circle", { class: "ds4free-face-mark ds4free-circle-mark", cx: "563.04", cy: "224.8", r: "8.7" }),
                h("path", { class: "ds4free-face-mark ds4free-triangle-mark", d: "M517.22 169.1 l9.1 16.1 h-18.2 Z" }),
                h("path", { class: "ds4free-face-mark ds4free-cross-mark", d: "M510.7 264.1 l13 13 M523.7 264.1 l-13 13" }),
                h("path", { class: "ds4free-stick-highlight", d: "M196 304 A27 27 0 0 1 243 304" }),
                h("path", { class: "ds4free-stick-highlight", d: "M396 304 A27 27 0 0 1 444 304" }),
                h("text", { class: "ds4free-guide-mark", x: "320.16", y: "318.5", "text-anchor": "middle" }, "PS"),
                h("text", { class: "ds4free-sys", x: "133", y: "63", "text-anchor": "middle" }, "L2"),
                h("text", { class: "ds4free-sys", x: "507", y: "63", "text-anchor": "middle" }, "R2"),
                h("text", { class: "ds4free-sys", x: "129", y: "121", "text-anchor": "middle" }, "L1"),
                h("text", { class: "ds4free-sys", x: "511", y: "121", "text-anchor": "middle" }, "R1"),
                h("text", { class: "ds4free-legend", x: "194", y: "137", "text-anchor": "middle" }, "SHARE"),
                h("text", { class: "ds4free-legend", x: "446", y: "137", "text-anchor": "middle" }, "OPTIONS"),
              ),
              h(
                "g",
                { class: "ds4premium-callouts" },
                h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "88", y: "48", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "82", y: "122", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "552", y: "48", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "558", y: "122", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "194", y: "193", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "446", y: "193", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "123", y: "159", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "123", y: "298", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "56", y: "229", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "190", y: "229", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "220", y: "319", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "220", y: "270", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "220", y: "382", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "171", y: "319", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "269", y: "319", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "420", y: "319", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "420", y: "270", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "420", y: "382", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "371", y: "319", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "469", y: "319", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "320", y: "350", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "517", y: "149", "text-anchor": "middle" }),
                h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "592", y: "229", "text-anchor": "start" }),
                h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "442", y: "229", "text-anchor": "end" }),
                h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "517", y: "317", "text-anchor": "middle" }),
              ),
            )
  );
}
