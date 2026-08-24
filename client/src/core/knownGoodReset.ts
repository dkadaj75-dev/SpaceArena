/**
 * The escalation rung of last resort: put the browser back to a known-good
 * display configuration and reload clean.
 *
 * Three separate things can pin a browser into a broken state with no UI that
 * says so, and this rung defeats all three at once:
 *
 *  1. `spacearena.renderer="webgpu"` persists a renderer that presents black on
 *     some GPUs. Settings writes it and only offers a manual reload, so it can
 *     activate silently on some later boot.
 *  2. The guard's own earlier rungs write `spacearena.rendererAutoFallback`,
 *     `spacearena.qualityAutoSafe` and `sa.quality="low"` — and NOTHING clears
 *     them, so a browser that once saw a black frame stays pinned to the low
 *     tier forever.
 *  3. A service worker left behind by a past production build keeps serving a
 *     stale shell from the same origin. A hard reload bypasses the HTTP cache
 *     but NOT a controlling worker, which is why "I hard-reloaded and nothing
 *     changed" is a real and very confusing symptom.
 *
 * What it must never cost the player: their session or their loadout. The key
 * list below is an allowlist of display state, and `accessToken`,
 * `refreshToken`, `guestToken` and every `hangar.*` key are explicitly out of
 * scope — a self-heal that logs you out is not a self-heal.
 */

import { createLogger } from "@space-arena/shared";

const log = createLogger("KnownGood");

/** One shot per browser, so this can never become a reload loop. */
export const NUKED_KEY = "spacearena.nukedToKnownGood";

/** Exactly the display state. Everything else in storage is none of our business. */
const DISPLAY_KEYS = ["spacearena.renderer", "sa.quality", "spacearena.rendererAutoFallback", "spacearena.qualityAutoSafe"];
const LEARNED_TIER_PREFIX = "sa.quality.learned.";

/** Query params that can re-pin the very state we are clearing. */
const STICKY_PARAMS = ["renderer", "editor", "login", "fakelag", "server"];

export interface KnownGoodDeps {
  storage?: Storage;
  location?: { href: string; replace(url: string): void };
  serviceWorker?: ServiceWorkerContainer;
  caches?: CacheStorage;
}

/** Which display keys are currently set — for the settings screen's button copy. */
export function displayOverridesInEffect(storage: Storage | undefined = safeStorage()): string[] {
  if (!storage) return [];
  const found: string[] = [];
  try {
    for (const key of DISPLAY_KEYS) if (storage.getItem(key) !== null) found.push(key);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(LEARNED_TIER_PREFIX)) found.push(key);
    }
  } catch {
    /* storage unavailable — report nothing rather than throwing */
  }
  return found;
}

function safeStorage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** Strip the params that would immediately restore the state we just cleared. */
export function cleanReloadUrl(href: string, stamp = Date.now()): string {
  const url = new URL(href);
  for (const param of STICKY_PARAMS) url.searchParams.delete(param);
  // `?renderer=webgpu` OUTRANKS localStorage at boot, so a plain
  // `location.reload()` here would preserve the very thing being reset.
  url.searchParams.set("nuked", String(stamp));
  return url.toString();
}

/**
 * Clear display state, evict every worker and cache, and reload to a clean URL.
 * Returns false without doing anything if this browser already used its one shot.
 */
export async function nukeToKnownGood(deps: KnownGoodDeps = {}): Promise<boolean> {
  const storage = deps.storage ?? safeStorage();
  const loc = deps.location ?? window.location;
  const sw = deps.serviceWorker ?? (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined);
  const cacheStore = deps.caches ?? (typeof caches !== "undefined" ? caches : undefined);

  try {
    if (storage?.getItem(NUKED_KEY)) {
      log.warn("known-good reset already used on this browser; not repeating");
      return false;
    }
  } catch {
    /* unreadable storage cannot prove we already fired; go ahead */
  }

  const cleared: string[] = [];
  try {
    if (storage) {
      // Snapshot the learned-tier keys first: removing while enumerating a live
      // Storage renumbers it and would skip half the entries.
      const learned: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(LEARNED_TIER_PREFIX)) learned.push(key);
      }
      for (const key of [...DISPLAY_KEYS, ...learned]) {
        if (storage.getItem(key) === null) continue;
        storage.removeItem(key);
        cleared.push(key);
      }
      storage.setItem(NUKED_KEY, String(Date.now()));
    }
  } catch (error) {
    // Private mode / blocked storage. Everything below is still worth doing.
    log.warn("could not clear display settings", { error });
  }

  let workers = 0;
  try {
    const regs = (await sw?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    workers = regs.length;
  } catch (error) {
    log.warn("could not unregister service workers", { error });
  }

  let cacheCount = 0;
  try {
    const keys = (await cacheStore?.keys()) ?? [];
    await Promise.all(keys.map((k) => cacheStore?.delete(k)));
    cacheCount = keys.length;
  } catch (error) {
    log.warn("could not clear caches", { error });
  }

  log.error("resetting to known-good display configuration", { cleared, workers, caches: cacheCount });
  // `replace`, not `reload`: reload would keep `?renderer=webgpu` in the URL.
  loc.replace(cleanReloadUrl(loc.href));
  return true;
}
