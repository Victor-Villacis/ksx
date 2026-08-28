/**
 * Canvas-safe identity for one complete raw device selector.
 *
 * The readable prefix is only for diagnostics. Identity comes from the
 * 64-bit FNV-1a fingerprint of every UTF-8 byte, so punctuation and selector
 * tails that disappear from the prefix do not collapse twin boards onto one
 * canvas item. The result stays inside CanvasItem's 96-character contract.
 */
export function deviceInstanceId(selector: string): string {
  const readable = selector
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "selector";

  let fingerprint = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(selector)) {
    fingerprint ^= BigInt(byte);
    fingerprint = BigInt.asUintN(64, fingerprint * 0x100000001b3n);
  }
  const suffix = fingerprint.toString(36).padStart(13, "0");
  return `dev-${readable}-${suffix}`;
}

/** The first device-workbench build used this lossy key. Read it only as a
 * geometry fallback so an existing local arrangement survives the upgrade. */
export function legacyDeviceInstanceId(selector: string): string {
  return `dev-${selector.replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(0, 96);
}

/** Choose the saved geometry slot for a device without reviving the legacy
 * collision. A legacy slot may belong to one raw selector for this mount
 * lifetime; another selector that collapsed to the same old key must use its
 * staggered home instead of being placed directly on top of the first.
 *
 * The owner map intentionally remembers the raw selector, not just a boolean,
 * so removing and re-adding that same board can still reuse its old position.
 */
export function claimSavedDeviceGeometryKey(
  selector: string,
  savedKeys: ReadonlySet<string>,
  legacyOwners: Map<string, string>,
): string | undefined {
  const current = deviceInstanceId(selector);
  if (savedKeys.has(current)) return current;

  const legacy = legacyDeviceInstanceId(selector);
  const owner = legacyOwners.get(legacy);
  if (!savedKeys.has(legacy) || (owner !== undefined && owner !== selector)) {
    return undefined;
  }
  legacyOwners.set(legacy, selector);
  return legacy;
}
