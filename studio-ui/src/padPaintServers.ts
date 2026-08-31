import { h } from "@getforma/core";

/** The paint servers every pad silhouette draws with: one zero-size SVG
 * whose defs resolve document-wide, so CSS can fill shells, wells, sticks
 * and buttons with real gradients instead of flats. Extracted from the
 * retired Nocturne island so the redesign mounts one set of paint servers
 * beside its shared masters. Keep it OUTSIDE any display:none
 * subtree: non-Chromium engines refuse gradient url() references into
 * hidden subtrees, and the visible clones resolve against THESE defs. */
export function PadPaintServers() {
  return (
  h(
    "svg",
    { class: "nx-defs", width: "0", height: "0", "aria-hidden": "true", focusable: "false" },
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: "nxg-shell", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#2b2e3e" }),
        h("stop", { offset: "0.55", "stop-color": "#20222f" }),
        h("stop", { offset: "1", "stop-color": "#191b26" }),
      ),
      h(
        "radialGradient",
        { id: "nxg-well", cx: "0.5", cy: "0.45", r: "0.65" },
        h("stop", { offset: "0", "stop-color": "#101219" }),
        h("stop", { offset: "0.8", "stop-color": "#14161f" }),
        h("stop", { offset: "1", "stop-color": "#1c1e2a" }),
      ),
      h(
        "radialGradient",
        { id: "nxg-stick", cx: "0.38", cy: "0.32", r: "0.85" },
        h("stop", { offset: "0", "stop-color": "#3d4156" }),
        h("stop", { offset: "0.55", "stop-color": "#2b2e3e" }),
        h("stop", { offset: "1", "stop-color": "#222434" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-btn", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#2a2d3c" }),
        h("stop", { offset: "0.5", "stop-color": "#20222f" }),
        h("stop", { offset: "1", "stop-color": "#1a1c27" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-touch", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#12141d" }),
        h("stop", { offset: "1", "stop-color": "#191b26" }),
      ),
      h(
        "radialGradient",
        { id: "nxg-lamp", cx: "0.5", cy: "0.4", r: "0.75" },
        h("stop", { offset: "0", "stop-color": "#cfc6f7" }),
        h("stop", { offset: "0.45", "stop-color": "#968ae0" }),
        h("stop", { offset: "1", "stop-color": "#5d5494" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-dpad-cap", x1: "0", y1: "0", x2: "0.82", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#686e7a" }),
        h("stop", { offset: "0.34", "stop-color": "#4b4f59" }),
        h("stop", { offset: "0.72", "stop-color": "#343740" }),
        h("stop", { offset: "1", "stop-color": "#25272e" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-dpad-bevel", x1: "0.1", y1: "0", x2: "0.88", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#5f646f" }),
        h("stop", { offset: "0.48", "stop-color": "#3f434c" }),
        h("stop", { offset: "1", "stop-color": "#202229" }),
      ),
      h(
        "radialGradient",
        { id: "nxg-ds4-button-rim", cx: "0.3", cy: "0.2", r: "0.86" },
        h("stop", { offset: "0", "stop-color": "#6d7380" }),
        h("stop", { offset: "0.42", "stop-color": "#4c515c" }),
        h("stop", { offset: "1", "stop-color": "#262930" }),
      ),
      h(
        "radialGradient",
        { id: "nxg-ds4-button-cap", cx: "0.32", cy: "0.22", r: "0.9" },
        h("stop", { offset: "0", "stop-color": "#555a65" }),
        h("stop", { offset: "0.55", "stop-color": "#41454f" }),
        h("stop", { offset: "1", "stop-color": "#272a31" }),
      ),
      h(
        "radialGradient",
        { id: "nxg-ds4-stick-rim", cx: "0.36", cy: "0.26", r: "0.82" },
        h("stop", { offset: "0", "stop-color": "#69707c" }),
        h("stop", { offset: "0.36", "stop-color": "#484d57" }),
        h("stop", { offset: "0.72", "stop-color": "#2b2e35" }),
        h("stop", { offset: "1", "stop-color": "#17191e" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-utility-cap", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#686e79" }),
        h("stop", { offset: "0.45", "stop-color": "#4b4f59" }),
        h("stop", { offset: "1", "stop-color": "#292c33" }),
      ),
      h(
        "pattern",
        { id: "nxp-ds4-stick-rubber", width: "18", height: "18", patternUnits: "userSpaceOnUse" },
        h("rect", { width: "18", height: "18", fill: "#353942" }),
        h("circle", { cx: "4", cy: "4", r: "1.35", fill: "#565b66", opacity: "0.72" }),
        h("circle", { cx: "13", cy: "11", r: "1.05", fill: "#202229", opacity: "0.78" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-jet-black", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#303139" }),
        h("stop", { offset: "0.48", "stop-color": "#202024" }),
        h("stop", { offset: "1", "stop-color": "#17171a" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-glacier-white", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ffffff" }),
        h("stop", { offset: "0.5", "stop-color": "#e4e4e6" }),
        h("stop", { offset: "1", "stop-color": "#c9cad0" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-magma-red", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ef4842" }),
        h("stop", { offset: "0.5", "stop-color": "#d42323" }),
        h("stop", { offset: "1", "stop-color": "#a81319" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-ds4-midnight-blue", x1: "0", y1: "0", x2: "0", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#3a5579" }),
        h("stop", { offset: "0.5", "stop-color": "#223355" }),
        h("stop", { offset: "1", "stop-color": "#14223a" }),
      ),
      // Product-photo-informed shell ramps for the three premium
      // controller families. They stay document-wide so cloned SVGs
      // never need private defs (the browser resolves every url()).
      h(
        "linearGradient",
        { id: "nxg-dualsense-white", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ffffff" }),
        h("stop", { offset: "0.48", "stop-color": "#d9dde6" }),
        h("stop", { offset: "1", "stop-color": "#aeb5c2" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-dualsense-midnight-black", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#4a4d5d" }),
        h("stop", { offset: "0.5", "stop-color": "#252733" }),
        h("stop", { offset: "1", "stop-color": "#10121a" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-dualsense-cosmic-red", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#e64c6b" }),
        h("stop", { offset: "0.5", "stop-color": "#b72446" }),
        h("stop", { offset: "1", "stop-color": "#74152c" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-dualsense-nova-pink", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ffa0bd" }),
        h("stop", { offset: "0.5", "stop-color": "#e86f99" }),
        h("stop", { offset: "1", "stop-color": "#a83d66" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-dualsense-starlight-blue", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#81c5e8" }),
        h("stop", { offset: "0.5", "stop-color": "#4b9fd0" }),
        h("stop", { offset: "1", "stop-color": "#24668f" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-dualsense-galactic-purple", x1: "0.16", y1: "0", x2: "0.84", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#a47bd5" }),
        h("stop", { offset: "0.5", "stop-color": "#7049a7" }),
        h("stop", { offset: "1", "stop-color": "#45296d" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-switchpro-carbon-black", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#737a80" }),
        h("stop", { offset: "0.52", "stop-color": "#52585c" }),
        h("stop", { offset: "1", "stop-color": "#292d31" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-switchpro-ink-pair", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#71808a" }),
        h("stop", { offset: "0.52", "stop-color": "#46515a" }),
        h("stop", { offset: "1", "stop-color": "#252b30" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-switchpro-crimson-red", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#d0525f" }),
        h("stop", { offset: "0.52", "stop-color": "#a82736" }),
        h("stop", { offset: "1", "stop-color": "#681720" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-switchpro-frost-white", x1: "0.08", y1: "0", x2: "0.92", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ffffff" }),
        h("stop", { offset: "0.52", "stop-color": "#eceef0" }),
        h("stop", { offset: "1", "stop-color": "#b9c0c7" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-xboxseries-black", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#515155" }),
        h("stop", { offset: "0.5", "stop-color": "#28282a" }),
        h("stop", { offset: "1", "stop-color": "#141416" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-xboxseries-white", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ffffff" }),
        h("stop", { offset: "0.5", "stop-color": "#d7d7d7" }),
        h("stop", { offset: "1", "stop-color": "#a9abad" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-xboxseries-blue", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#3677db" }),
        h("stop", { offset: "0.5", "stop-color": "#1c448a" }),
        h("stop", { offset: "1", "stop-color": "#102750" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-xboxseries-red", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#ff4b44" }),
        h("stop", { offset: "0.5", "stop-color": "#e71717" }),
        h("stop", { offset: "1", "stop-color": "#8b0b0b" }),
      ),
      h(
        "linearGradient",
        { id: "nxg-xboxseries-green", x1: "0.12", y1: "0", x2: "0.88", y2: "1" },
        h("stop", { offset: "0", "stop-color": "#e1f668" }),
        h("stop", { offset: "0.5", "stop-color": "#c1db31" }),
        h("stop", { offset: "1", "stop-color": "#728b12" }),
      ),
      // A compact touch texture for the free DS4's 640-unit source.
      // Hoisting it keeps every clone on the same app-owned paint.
      h(
        "pattern",
        { id: "nxp-ds4-touch", width: "5.48", height: "5.48", patternUnits: "userSpaceOnUse" },
        h("circle", { cx: "1.1", cy: "1.1", r: "0.72", fill: "#080910" }),
      ),
      h(
        "pattern",
        { id: "nxp-ds4-paid-touch", width: "32.531", height: "32.531", patternUnits: "userSpaceOnUse" },
        h("circle", { cx: "4.597", cy: "4.597", r: "4.15", fill: "#090a10" }),
      ),
    ),
  )
  );
}
