import { h } from "@getforma/core";

import {
  DualSensePremiumButtonHooks,
  DualSensePremiumDepth,
  DualSensePremiumGeometry,
} from "./dualSensePremiumGeometry";

/**
 * Complete inline DualSense master for the Nocturne controller widget.
 *
 * Paint, hit geometry, and labels deliberately live in sibling groups: the
 * detailed body never intercepts input, while every transparent hook remains
 * an exact whole-control target above it.
 */
export function DualSensePremiumArt() {
  return h(
    "svg",
    {
      class: "wspad ps5a dualsensepremium",
      viewBox: "70 216 940 640",
      preserveAspectRatio: "xMidYMid meet",
      "data-controller-variant": "white",
      "data-dualsense-variant": "white",
      "aria-hidden": "true",
      focusable: "false",
    },
    h(
      "g",
      { class: "ps5a-body dualsensepremium-body" },
      h(
        "g",
        { class: "dualsensepremium-paid", transform: "matrix(0.2421052632 0 0 0.2421052632 80 234)" },
        h(DualSensePremiumDepth, null),
        h(DualSensePremiumGeometry, null),
      ),
      h(
        "g",
        { class: "dualsensepremium-bumpers", "aria-hidden": "true" },
        h("rect", {
          class: "dualsensepremium-bumper-shadow dualsensepremium-bumper-shadow-left",
          x: "152",
          y: "294",
          width: "132",
          height: "36",
          rx: "17",
        }),
        h("rect", {
          class: "ps5a-shoulder dualsensepremium-bumper dualsensepremium-bumper-left",
          x: "152",
          y: "288",
          width: "132",
          height: "36",
          rx: "17",
        }),
        h("rect", {
          class: "dualsensepremium-bumper-sheen dualsensepremium-bumper-sheen-left",
          x: "160",
          y: "292",
          width: "116",
          height: "7",
          rx: "3.5",
        }),
        h("rect", {
          class: "dualsensepremium-bumper-shadow dualsensepremium-bumper-shadow-right",
          x: "798",
          y: "294",
          width: "132",
          height: "36",
          rx: "17",
        }),
        h("rect", {
          class: "ps5a-shoulder dualsensepremium-bumper dualsensepremium-bumper-right",
          x: "798",
          y: "288",
          width: "132",
          height: "36",
          rx: "17",
        }),
        h("rect", {
          class: "dualsensepremium-bumper-sheen dualsensepremium-bumper-sheen-right",
          x: "806",
          y: "292",
          width: "116",
          height: "7",
          rx: "3.5",
        }),
      ),
    ),
    h(
      "g",
      { class: "dualsensepremium-hooks" },
      h(DualSensePremiumButtonHooks, null),
    ),
    h(
      "g",
      { class: "dualsensepremium-callouts" },
      h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "182", y: "262", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "144", y: "313", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "900", y: "262", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "938", y: "313", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "326", y: "272", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "757", y: "272", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "255", y: "322", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "255", y: "504", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "170", y: "414", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "341", y: "414", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "396", y: "654", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "396", y: "466", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "336", y: "628", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "306", y: "551", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "486", y: "551", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "685", y: "656", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "685", y: "468", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "745", y: "630", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "595", y: "553", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "775", y: "553", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "542", y: "580", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "830", y: "300", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "940", y: "414", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "720", y: "414", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "830", y: "534", "text-anchor": "middle" }),
    ),
  );
}
