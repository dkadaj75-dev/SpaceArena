/**
 * Page-side policy for a service worker that has already taken control.
 *
 * Workbox activates the new worker immediately. This gate decides whether the
 * currently loaded page can safely reload now or must wait for its match to
 * finish. It deliberately has no browser dependencies so the policy is easy
 * to exercise in unit tests.
 */
export interface UpdateGate {
  /**
   * Records a controller change. A page's first controller claim is normal
   * startup, not an app update, and must be ignored.
   */
  noteControllerChange(hadPreviousController: boolean): boolean;
  /** Records an update that is ready to apply and returns whether to reload. */
  noteUpdateReady(): boolean;
  /** Called when the app returns from a match to a safe screen. */
  onSafeMoment(): boolean;
}

export function createUpdateGate({ isMatchLive }: { isMatchLive: () => boolean }): UpdateGate {
  let updatePending = false;
  let reloadRequested = false;

  function shouldReload(): boolean {
    if (!updatePending || reloadRequested || isMatchLive()) return false;
    reloadRequested = true;
    return true;
  }

  return {
    noteControllerChange(hadPreviousController): boolean {
      if (!hadPreviousController) return false;
      return this.noteUpdateReady();
    },
    noteUpdateReady(): boolean {
      updatePending = true;
      return shouldReload();
    },
    onSafeMoment(): boolean {
      return shouldReload();
    },
  };
}
