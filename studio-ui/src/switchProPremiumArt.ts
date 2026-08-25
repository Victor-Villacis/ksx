import { h } from "@getforma/core";
import {
  SwitchProPremiumButtonHooks,
  SwitchProPremiumDepth,
  SwitchProPremiumGeometry,
} from "./switchProPremiumGeometry";

/** Complete inline Switch Pro master. Paint servers remain document-wide and
 * app-owned; this component contains only vector geometry, depth, hooks and
 * mapper callouts in the source's identity coordinate space. */
export function SwitchProPremiumArt() {
  return h(
    "svg",
    {
      class: "wspad switchproa switchpropremium",
      viewBox: "10 145 940 670",
      preserveAspectRatio: "xMidYMid meet",
      "data-controller-variant": "carbon-black",
      "data-switchpro-variant": "carbon-black",
      "aria-hidden": "true",
      focusable: "false",
    },
    h(
      "g",
      { class: "switchpro-premium-body" },
      SwitchProPremiumDepth(),
      SwitchProPremiumGeometry(),
    ),
    h(
      "g",
      { class: "switchpro-premium-hooks" },
      SwitchProPremiumButtonHooks(),
    ),
    h(
      "g",
      { class: "switchpro-premium-callouts", "aria-hidden": "true" },
      // Rear ZL/ZR silhouettes, then the app-owned L/R bumper plates.
      h("text", { class: "n-fnkey", "data-fn": "lt", "data-live-chatter": "", x: "112", y: "184", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rt", "data-live-chatter": "", x: "848", y: "184", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "lb", "data-live-chatter": "", x: "118", y: "228", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rb", "data-live-chatter": "", x: "842", y: "228", "text-anchor": "start" }),

      // The cross is one authored cap, but each arm keeps its own mapper label.
      h("text", { class: "n-fnkey", "data-fn": "dpad.up", "data-live-chatter": "", x: "339", y: "398", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.left", "data-live-chatter": "", x: "256", y: "486", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.down", "data-live-chatter": "", x: "339", y: "574", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "dpad.right", "data-live-chatter": "", x: "422", y: "486", "text-anchor": "start" }),

      // Nintendo face order: X north, A east, B south and Y west.
      h("text", { class: "n-fnkey", "data-fn": "x", "data-live-chatter": "", x: "722", y: "246", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "a", "data-live-chatter": "", x: "840", y: "359", "text-anchor": "start" }),
      h("text", { class: "n-fnkey", "data-fn": "b", "data-live-chatter": "", x: "722", y: "464", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "y", "data-live-chatter": "", x: "610", y: "359", "text-anchor": "end" }),

      // Capture is Back in the mapper, Plus is Start and Home is Guide.
      h("text", { class: "n-fnkey", "data-fn": "back", "data-live-chatter": "", x: "415", y: "392", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "start", "data-live-chatter": "", x: "593", y: "246", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "guide", "data-live-chatter": "", x: "545", y: "394", "text-anchor": "middle" }),

      // Left stick labels sit around its 86-unit well, clear of the rubber cap.
      h("text", { class: "n-fnkey", "data-fn": "lthumb", "data-live-chatter": "", x: "225", y: "458", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ly.max", "data-live-chatter": "", x: "227", y: "260", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ly.min", "data-live-chatter": "", x: "227", y: "440", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "lx.min", "data-live-chatter": "", x: "132", y: "358", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "lx.max", "data-live-chatter": "", x: "320", y: "358", "text-anchor": "start" }),

      // The right stick has the same five-zone vocabulary at its lower position.
      h("text", { class: "n-fnkey", "data-fn": "rthumb", "data-live-chatter": "", x: "601", y: "590", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ry.max", "data-live-chatter": "", x: "601", y: "390", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "ry.min", "data-live-chatter": "", x: "601", y: "575", "text-anchor": "middle" }),
      h("text", { class: "n-fnkey", "data-fn": "rx.min", "data-live-chatter": "", x: "506", y: "485", "text-anchor": "end" }),
      h("text", { class: "n-fnkey", "data-fn": "rx.max", "data-live-chatter": "", x: "696", y: "485", "text-anchor": "start" }),
    ),
  );
}
