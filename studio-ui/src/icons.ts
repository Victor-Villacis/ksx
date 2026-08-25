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

/** Phosphor `palette` (bold) — pick a controller's color. */
export const ICON_PALETTE =
  "M203.57,51A107.9,107.9,0,0,0,20,128c0,44.72,27.6,82.25,72,97.94A36,36,0,0,0,140,192a12,12,0,0,1,12-12h46.21a35.79,35.79,0,0,0,35.1-28A108.6,108.6,0,0,0,236,127.09,107.23,107.23,0,0,0,203.57,51Zm6.34,95.67a11.91,11.91,0,0,1-11.7,9.3H152a36,36,0,0,0-36,36,12,12,0,0,1-16,11.3c-16.65-5.88-30.65-15.76-40.48-28.56A76,76,0,0,1,44,128a84,84,0,0,1,83.13-84H128a84.35,84.35,0,0,1,84,83.29A84.72,84.72,0,0,1,209.91,146.71ZM144,76a16,16,0,1,1-16-16A16,16,0,0,1,144,76Zm-44,24A16,16,0,1,1,84,84,16,16,0,0,1,100,100Zm0,56a16,16,0,1,1-16-16A16,16,0,0,1,100,156Zm88-56a16,16,0,1,1-16-16A16,16,0,0,1,188,100Z";

/** Phosphor `dots-six-vertical` (bold) — the drag grip. */
export const ICON_GRIP =
  "M108,60A16,16,0,1,1,92,44,16,16,0,0,1,108,60Zm56,16a16,16,0,1,0-16-16A16,16,0,0,0,164,76ZM92,112a16,16,0,1,0,16,16A16,16,0,0,0,92,112Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,112ZM92,180a16,16,0,1,0,16,16A16,16,0,0,0,92,180Zm72,0a16,16,0,1,0,16,16A16,16,0,0,0,164,180Z";

/** Phosphor `caret-up` / `caret-down` (bold) — move a slot in the order. */
export const ICON_CARET_UP =
  "M216.49,168.49a12,12,0,0,1-17,0L128,97,56.49,168.49a12,12,0,0,1-17-17l80-80a12,12,0,0,1,17,0l80,80A12,12,0,0,1,216.49,168.49Z";
export const ICON_CARET_DOWN =
  "M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z";

/** Phosphor `copy` (bold) — duplicate a controller. */
export const ICON_COPY =
  "M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z";

/** Phosphor `minus` (bold) — remove one key from one control. */
export const ICON_MINUS =
  "M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z";

/** Phosphor `plus` (bold) — add a key / add a trigger. */
export const ICON_PLUS =
  "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z";
