/**
 * The Studio's icon library: Phosphor Icons (bold weight), MIT license.
 * https://phosphoricons.com — © Phosphor Icons, path data reproduced under
 * the MIT license. Every icon is a 256×256 `viewBox` single-path SVG drawn
 * with `fill: currentColor`, sized by the shared `.n-ico` class.
 *
 * HOW TO USE — two rules, both compiler-driven:
 *  - Outside list bodies, import a path constant and inline the element:
 *      h("svg", { class: "n-ico", viewBox: "0 0 256 256", "aria-hidden": "true" },
 *        h("path", { d: ICON_X }))
 *  - INSIDE createList bodies, paste the path string as a literal — list
 *    templates serialize at build time and cross-file constant resolution
 *    is not part of the compiler contract. Keep this file the source of
 *    truth and copy from it.
 *
 * Icon-only buttons ALWAYS carry an aria-label (the no-icon-library-era
 * a11y rule survives the library).
 */

/** Phosphor `x` (bold) — clear / unbind / close. */
export const ICON_X =
  "M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z";

/** Phosphor `plus` (bold) — add a key / add a trigger. */
export const ICON_PLUS =
  "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z";
