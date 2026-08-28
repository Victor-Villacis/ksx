// The workbench's one ordering computation, standalone and pure so the test
// runner can import it without dragging the canvas engine along (the
// device-instance-id precedent).

/** The whole slot order with `moving` re-seated at `position` (1-based) —
 *  the permutation the move verb wants. Survivors keep their relative
 *  arrival order; the daemon renumbers. An out-of-range position clamps to
 *  the nearest end rather than inventing a slot. */
export function composeOrderMoving(
  numbers: string[],
  moving: string,
  position: number,
): string {
  const rest = numbers.filter((n) => n !== moving);
  const at = Math.max(0, Math.min(rest.length, position - 1));
  rest.splice(at, 0, moving);
  return rest.join(" ");
}
