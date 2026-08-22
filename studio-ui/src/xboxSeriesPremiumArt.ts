import { h } from "@getforma/core";

import {
  XboxSeriesPremiumButtonHooks,
  XboxSeriesPremiumDepth,
  XboxSeriesPremiumGeometry,
} from "./xboxSeriesPremiumGeometry";

/**
 * Complete inline Xbox Series X|S master for the Nocturne controller widget.
 *
 * Paint, explicit depth, mapper hit geometry, and callouts stay in separate
 * sibling groups. Share remains visual-only because it has no distinct mapper
 * function; every one of the 25 canonical controls has one exact hook and one
 * matching callout in the paid source's identity coordinate space.
 */
export function XboxSeriesPremiumArt() {
  return h(
    "svg",
    {
      class: "wspad xboxseriesa xboxseriespremium",
      viewBox: "0 0 3800 2647",
      preserveAspectRatio: "xMidYMid meet",
      "data-controller-variant": "black",
      "data-xboxseries-variant": "black",
      "aria-hidden": "true",
      focusable: "false",
    },
    h(
      "g",
      { class: "xboxseriespremium-body" },
      XboxSeriesPremiumDepth(),
      XboxSeriesPremiumGeometry(),
    ),
    h(
      "g",
      { class: "xboxseriespremium-hook-layer" },
      XboxSeriesPremiumButtonHooks(),
    ),
    h(
      "g",
      { class: "xboxseriespremium-callouts", "aria-hidden": "true" },
      h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "545", y: "224", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "3255", y: "224", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "610", y: "390", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "3190", y: "390", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "1621", y: "584", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "2179", y: "584", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "1062", y: "1372", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "1396", y: "1038", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "1729", y: "1372", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "1396", y: "1697", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "2446", y: "728", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "3317", y: "728", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "2882", y: "1160", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "2882", y: "276", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "1900", y: "296", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "921", y: "1053", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "921", y: "440", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "921", y: "1020", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "604", y: "740", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "1238", y: "740", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "2408", y: "1626", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "2408", y: "994", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "2408", y: "1591", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "2090", y: "1310", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "2726", y: "1310", "text-anchor": "start" }),
    ),
  );
}
