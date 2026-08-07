import { createLogger } from "@space-arena/shared";

const log = createLogger("ContentRecovery");

/**
 * Boot-time self-heal for a version-skewed content pack.
 *
 * The deploy is atomic on the server, but not at the client: the app shell is
 * served from the service worker's precache while `/content/*.json` is
 * network-first (vite.config.ts, ROADMAP S6). Right after a deploy that
 * changes the content schema, a returning player therefore boots the OLD
 * precached client against the NEW pack — every config fails validation and
 * the menu never becomes playable. The pairing is stale until the freshly
 * installed service worker takes over, which only happens on the NEXT
 * navigation.
 *
 * So when the pack fails validation at boot, force that next navigation now:
 * ask the registration for an update, wait for the incoming worker to
 * activate (`skipWaiting` makes that prompt), drop the content JSON cache so
 * the reload cannot resurrect a stale fallback, and reload once.
 *
 * Guarded to a single attempt per session — if the server itself is serving a
 * broken pack, reloading forever would just hide the console evidence.
 */

/** Session flag that survives the self-heal reload and stops a second one. */
const ATTEMPT_KEY = "sa:content-recovery-attempted";

/** Runtime cache that could re-serve the stale pack after reload. */
const CONTENT_CACHE = "space-arena-content-json";

/** How long to give the new worker to download + activate before giving up. */
const ACTIVATION_TIMEOUT_MS = 25_000;

/**
 * Returns true when a reload is in flight and boot should stop; false when
 * there is nothing newer to reload into and the caller should surface the
 * failure normally.
 */
export async function recoverFromStaleContentPack(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  let attempted = false;
  try {
    attempted = sessionStorage.getItem(ATTEMPT_KEY) !== null;
    sessionStorage.setItem(ATTEMPT_KEY, String(Date.now()));
  } catch {
    // Storage denied (private mode quirks): recover, but without loop
    // protection there is exactly one try — the flag below covers it.
  }
  if (attempted) {
    log.warn("content pack still invalid after a recovery reload — giving up");
    return false;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;

  log.warn("content pack failed validation — checking for a newer app version");
  const updated = await waitForUpdatedWorker(registration, ACTIVATION_TIMEOUT_MS);
  if ("caches" in globalThis) {
    await caches.delete(CONTENT_CACHE).catch(() => undefined);
  }
  if (!updated) {
    // Same client would boot against the same pack: a reload can only loop.
    log.warn("no newer version available — surfacing the failure");
    return false;
  }
  log.warn("newer version activated — reloading into it");
  location.reload();
  return true;
}

/**
 * Kick an update check and resolve true once a NEW worker reaches
 * "activated" (or is already waiting/installing when we look), false when the
 * check finds nothing within the timeout.
 */
async function waitForUpdatedWorker(
  registration: ServiceWorkerRegistration,
  timeoutMs: number,
): Promise<boolean> {
  const done = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const watch = (worker: ServiceWorker | null): void => {
      if (!worker) return;
      if (worker.state === "activated") {
        clearTimeout(timer);
        resolve(true);
        return;
      }
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") {
          clearTimeout(timer);
          resolve(true);
        }
        // "redundant" means THIS worker lost the install race; the
        // updatefound listener below picks up its replacement.
      });
    };
    registration.addEventListener("updatefound", () => watch(registration.installing));
    // An update may already be mid-flight from a previous check.
    watch(registration.installing);
    watch(registration.waiting);
  });
  await registration.update().catch(() => undefined);
  return done;
}
