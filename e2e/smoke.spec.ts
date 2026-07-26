import { expect, test } from "@playwright/test";

/**
 * End-to-end smoke test (ROADMAP §11 6.1).
 *
 * One test, one sequential journey through the whole client:
 *   guest login → lobby → hangar (fit + save a fitting) → lobby →
 *   practice match → fire a module → match ends → back to the lobby.
 *
 * Everything is driven through real UI affordances and real player orders. The
 * only concession to headless CI is `window.__debug.forceFrame()` (installed by
 * client/src/main.ts in DEV), used purely as a TIME ACCELERATOR: it runs the
 * exact same `renderFrame()` the rAF loop runs — sim tick, event drain, HUD and
 * view sync — so a ~20 s practice match finishes in a couple of seconds without
 * anything reaching into the simulation to mutate state.
 */

// --- Shapes of the DEV debug surface we touch (see client/src/main.ts) ---

interface DebugVec2 {
  x: number;
  z: number;
}

interface DebugModule {
  moduleId: string;
  hardpointIndex: number;
  state: string;
}

interface DebugShip {
  id: number;
  team: number;
  pos: DebugVec2;
  heading: number;
  hull: number;
  modules: DebugModule[];
}

interface DebugSnapshot {
  phase: string;
  elapsed: number;
  ships: DebugShip[];
}

interface DebugSession {
  playerId: number;
  curSnapshot: DebugSnapshot;
  /** The same entry point every HUD tap uses (`GameSession.order`). */
  order(order: unknown): void;
}

interface DebugApi {
  /** Runs one full render frame (sim tick + HUD/view sync) with an explicit dt. */
  forceFrame(dtMs?: number): void;
  readonly session?: DebugSession;
}

interface PumpResult {
  ok: boolean;
  reason?: string;
  frames: number;
  phase: string;
  simSeconds: number;
  enemiesLeft: number;
}

/** Outcome banners `ResultsOverlay` can show for a finished match. */
const OUTCOMES = /^(TARGETS CLEARED|VICTORY|DEFEAT|DRAW)$/;

test("guest can log in, fit a ship, play a practice match and return to the lobby", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console: ${msg.text()}`);
  });

  // ---------------------------------------------------------------- 1. login
  // `?login=1` suppresses main.ts's DEV auto-login so the real guest flow runs.
  await page.goto("/?login=1");

  const authOverlay = page.locator(".auth-overlay");
  await expect(authOverlay).toBeVisible();
  await authOverlay.getByRole("button", { name: "Play as Guest", exact: true }).click();

  const lobby = page.locator(".lobby-overlay");
  await expect(lobby).toBeVisible();
  // Guest header: credits chip + the "upgrade this throwaway account" link.
  await expect(lobby.locator(".sa-menu-account .credits")).toHaveText(/^\d+ cr$/);
  await expect(lobby.getByText("Upgrade account", { exact: true })).toBeVisible();

  // --------------------------------------------------------------- 2. hangar
  await lobby.getByRole("button", { name: "Hangar", exact: true }).click();

  const hangar = page.locator(".hangar-panel");
  await expect(hangar).toBeVisible();
  const shipButtons = hangar.locator(".hangar-ship-btn");
  await expect(shipButtons.first()).toBeVisible();
  expect(await shipButtons.count()).toBeGreaterThan(0);

  // ----------------------------------------------------------- 3. fit a slot
  const slot = hangar.locator(".hangar-slot").first();
  const slotLabel = slot.locator(".hangar-slot-label");

  // Ships arrive pre-filled from their `defaultFitting`, so empty the slot
  // first — that makes "the slot gained `filled`" an actual state change.
  await slot.click();
  const picker = hangar.locator(".hangar-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Remove module", exact: true }).click();
  await expect(slot).not.toHaveClass(/\bfilled\b/);
  await expect(slotLabel).toHaveText("Empty");

  // Re-open and equip. A new account owns every `price: 0` module
  // (server/src/db/seed.ts → seedNewUser), so at least one candidate renders an
  // `Equip` button rather than `Buy (… cr)`.
  await slot.click();
  await expect(picker).toBeVisible();
  const equipButtons = picker.getByRole("button", { name: "Equip", exact: true });
  await expect(equipButtons.first()).toBeVisible();
  await equipButtons.first().click();

  await expect(slot).toHaveClass(/\bfilled\b/);
  await expect(slotLabel).not.toHaveText("Empty");

  // Persist it. The button is "Save new fitting" for a fresh fit and
  // "Update fitting" once one is selected — accept whichever rendered.
  const saveButton = hangar.locator(".hangar-fit-controls .hangar-btn-primary");
  await expect(saveButton).toHaveText(/^(Save new fitting|Update fitting)$/);
  await hangar.locator(".hangar-input").fill("E2E Smoke Fit");
  await saveButton.click();

  // A saved fitting becomes the selected one, which is what flips the label.
  await expect(saveButton).toHaveText("Update fitting");
  await expect(hangar.locator(".hangar-error")).toHaveCount(0);

  // ------------------------------------------------------- 4. back to lobby
  await hangar.locator(".hangar-close").click();
  await expect(lobby).toBeVisible();

  // ------------------------------------------------- 5. start a practice match
  await lobby.getByRole("button", { name: "Practice — Dummies", exact: true }).click();
  await expect(lobby).toBeHidden();

  const moduleButtons = page.locator(".hud-modules .hud-module-btn");
  await expect(moduleButtons).toHaveCount(4);
  // Starts as "FPS: --" and only becomes a number once the render loop ticks.
  await expect(page.locator(".hud-fps")).toHaveText(/^FPS: \d+$/);

  // ----------------------------------------------------- 6. drive the match
  // A real tap on the first module button issues a `moduleToggle` order; the
  // module leaves `retracted` via deploying → active (ModuleButtons.update
  // mirrors the sim state onto a `state-*` class).
  const firstModule = moduleButtons.first();
  await expect(firstModule).toHaveClass(/state-retracted/);
  await firstModule.click();
  await expect(firstModule).toHaveClass(/state-(deploying|active)/);
  await expect(firstModule).not.toHaveClass(/state-retracted/);

  // ------------------------------------------- 7. run the match to completion
  // Practice is `destroyTargets: 3` against 3 static dummies laid out just ahead
  // of the player's spawn. We issue only the orders a human's HUD produces —
  // `flight` from the stick/throttle and `moduleToggle` from the module buttons
  // (targeting is automatic in the sim, FLIGHT.md §2) — and use forceFrame to
  // compress ~20 s of match time into a couple of seconds.
  const pump = await page.evaluate<PumpResult, { maxFrames: number; standoff: number }>(
    async ({ maxFrames, standoff }) => {
      const debug = (window as unknown as { __debug?: DebugApi }).__debug;
      const fail = (reason: string): PumpResult => ({
        ok: false,
        reason,
        frames: 0,
        phase: "unknown",
        simSeconds: 0,
        enemiesLeft: -1,
      });
      if (!debug) return fail("window.__debug is missing — is the client running a DEV build?");

      /** ~5 fixed 30 Hz ticks per forced frame (GameLoop caps at maxTicksPerFrame). */
      const FRAME_MS = 166;
      /** Forced frames between DOM checks. Orders are refreshed every frame. */
      const BATCH = 20;

      let frames = 0;
      let phase = "live";
      let simSeconds = 0;
      let enemiesLeft = -1;

      /** Shortest signed delta from `from` to `to`, in (-PI, PI]. */
      const angleTo = (from: number, to: number): number => {
        let d = (to - from) % (Math.PI * 2);
        if (d > Math.PI) d -= Math.PI * 2;
        if (d <= -Math.PI) d += Math.PI * 2;
        return d;
      };

      /**
       * One frame of "pilot": put the nose on the nearest enemy with the stick,
       * hold station at `standoff` with the throttle, and keep the guns up. The
       * sim's automatic targeting locks whatever the nose is pointed at.
       */
      const fly = (session: DebugSession): void => {
        const snapshot = session.curSnapshot;
        phase = snapshot.phase;
        simSeconds = snapshot.elapsed;
        const me = snapshot.ships.find((s) => s.id === session.playerId);
        if (!me) return;
        const foes = snapshot.ships.filter((s) => s.team !== me.team);
        enemiesLeft = foes.length;

        let nearest: DebugShip | null = null;
        let nearestDist = Infinity;
        for (const foe of foes) {
          const d = Math.hypot(foe.pos.x - me.pos.x, foe.pos.z - me.pos.z);
          if (d < nearestDist) {
            nearestDist = d;
            nearest = foe;
          }
        }

        if (nearest) {
          const bearing = Math.atan2(nearest.pos.z - me.pos.z, nearest.pos.x - me.pos.x);
          const err = angleTo(me.heading, bearing);
          session.order({
            kind: "flight",
            // Proportional stick: the order is re-sent every forced frame, so a
            // simple gain settles the nose without hunting.
            turn: Math.max(-1, Math.min(1, err * 2)),
            // Close to the standoff band, then cut the engine and shoot from there.
            throttle: nearestDist > standoff ? 0.6 : 0,
            boost: false,
          });
        }

        // Keep the guns up. Overheated/deploying modules ignore or don't need a
        // toggle, so only nudge the ones that are genuinely offline.
        for (const mod of me.modules) {
          if (mod.state !== "retracted") continue;
          if (!/laser|kinetic|missile/.test(mod.moduleId)) continue;
          session.order({ kind: "moduleToggle", hardpointIndex: mod.hardpointIndex });
        }
      };

      while (frames < maxFrames) {
        const session = debug.session;
        if (!session) {
          return { ...fail("no live session"), frames };
        }

        for (let i = 0; i < BATCH; i++) {
          fly(session);
          debug.forceFrame(FRAME_MS);
          frames += 1;
        }

        if (document.querySelector(".hud-results.visible")) {
          const done = debug.session?.curSnapshot;
          return {
            ok: true,
            frames,
            phase: done?.phase ?? phase,
            simSeconds: done?.elapsed ?? simSeconds,
            enemiesLeft,
          };
        }

        // Yield so the page's own rAF loop, network and timers keep running.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      return {
        ...fail("results overlay never became visible"),
        frames,
        phase,
        simSeconds,
        enemiesLeft,
      };
    },
    { maxFrames: 1500, standoff: 24 },
  );

  expect(
    pump.ok,
    `match never ended: ${pump.reason ?? ""} (frames=${pump.frames}, phase=${pump.phase}, ` +
      `simSeconds=${pump.simSeconds.toFixed(1)}, enemiesLeft=${pump.enemiesLeft})`,
  ).toBe(true);

  const results = page.locator(".hud-results");
  await expect(results).toHaveClass(/\bvisible\b/);
  await expect(results.locator(".hud-results-title")).toHaveText(OUTCOMES);

  // ------------------------------------------------------ 8. back to the lobby
  await results.locator("[data-results-action='menu']").click();
  await expect(lobby).toBeVisible();
  await expect(results).toHaveCount(0);

  expect(consoleErrors, `page reported errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
