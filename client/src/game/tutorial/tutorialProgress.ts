/**
 * Whether this browser has been through flight school.
 *
 * Persisted, but deliberately NOT gating: the owner's call (2026-08-08) is that
 * the TUTORIAL button stays on the menu forever — a player who wants to run it
 * again may. What the flag is for is everything downstream: a first-run nudge,
 * a "new pilot" telemetry cut, and eventually an auto-launch on a truly first
 * boot. Skipping counts as completing, because the player made a decision and
 * being asked again would be the game arguing with them.
 */
const KEY = "sa.tutorial.completed";

/** Storage that behaves in a private-mode/SSR context where localStorage throws. */
function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function tutorialCompleted(): boolean {
  try {
    return store()?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markTutorialCompleted(): void {
  try {
    store()?.setItem(KEY, "1");
  } catch {
    // A pilot with storage disabled simply gets asked again next visit. That is
    // a nudge repeated, not a broken tutorial.
  }
}

/** Used by tests and by a dev reset; never wired to a shipped control. */
export function clearTutorialProgress(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
