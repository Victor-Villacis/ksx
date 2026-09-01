/** Accessible names for icon-only destructive controller actions. Kept pure
 * so identity cannot regress behind a generic "Remove"/"Discard" label. */
export function controllerRemoveAccessibleName(displayName: string): string {
  const identity = displayName.trim() || "selected controller";
  return `Remove ${identity} from the draft`;
}

export function parkedControllerDiscardAccessibleName(
  displayName: string,
  preset: string,
): string {
  const identity = displayName.trim() || "parked controller";
  const route = preset.trim();
  return `Discard ${identity}${route ? ` · ${route}` : ""}`;
}
