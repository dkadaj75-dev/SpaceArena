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
  locked: boolean;
  targetId: number | null;
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

  // The launch fullscreen offer is a real modal over the first screen — a
  // player answers it before anything else, and so does this pilot. ("Not now":
  // requestFullscreen inside a headless run has nothing useful to do.)
  const fullscreenPrompt = page.locator(".sa-fullscreen-prompt");
  await expect(fullscreenPrompt).toBeVisible();
  await fullscreenPrompt.getByText("Not now", { exact: true }).click();
  await expect(fullscreenPrompt).toBeHidden();

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
  // Outfitting rail (2026-07-31): a column of bays on the left decides what the
  // panel shows. Hardpoints is where it opens.
  const rail = (name: string) => hangar.locator(`.hangar-rail-btn[data-category="${name}"]`);
  await expect(rail("hardpoints")).toHaveClass(/\bactive\b/);
  await rail("ship").click();

  const shipButtons = hangar.locator(".hangar-ship-btn");
  await expect(shipButtons.first()).toBeVisible();
  expect(await shipButtons.count()).toBeGreaterThan(0);

  // Arrows over the 3D stage step the bay the same way a swipe does — browsing
  // only, so the hull on screen changes and nothing else. Stepping runs a slide
  // transition first, so this waits for the name rather than expecting it on the
  // next frame.
  const currentShipName = hangar.locator(".hangar-ship-current .hangar-ship-name");
  const before = await currentShipName.textContent();
  await page.locator(".hangar-stage-arrow.next").click();
  await expect(currentShipName).not.toHaveText(before ?? "");

  // Browsing is not choosing: making this hull the one you fly is a separate,
  // explicit act. Pick the heavy hull, since its stock fit carries the shield
  // the match phase below toggles.
  await shipButtons.filter({ hasText: "Brawler" }).click();
  await hangar.getByRole("button", { name: "★ Set as main" }).click();
  await expect(hangar.locator(".hangar-badge.main")).toBeVisible();

  // ----------------------------------------------------------- 3. fit a slot
  await rail("hardpoints").click();
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
  await rail("fitting").click();
  const saveButton = hangar.locator(".hangar-fit-controls .hangar-btn-primary");
  await expect(saveButton).toHaveText(/^(Save new fitting|Update fitting)$/);
  await hangar.locator(".hangar-input").fill("E2E Smoke Fit");
  await saveButton.click();

  // A saved fitting becomes the selected one, which is what flips the label.
  await expect(saveButton).toHaveText("Update fitting");
  await expect(hangar.locator(".hangar-error")).toHaveCount(0);

  // The hangar is split in two: the ship's 3D stage and this panel, siblings
  // under the overlay. (Which half is which flips with orientation, in CSS.)
  await expect(page.locator(".hangar-overlay > .hangar-stage")).toHaveCount(1);

  // The hull's slots split into weapon hardpoints and the always-on internal
  // bay (2026-07-31); the rail shows one bay at a time, so count them one bay at
  // a time. Only hardpoints get a HUD button, so that is the count the match
  // must show.
  await rail("hardpoints").click();
  const hangarWeaponSlots = await hangar.locator('.hangar-slot[data-kind="hardpoint"]').count();
  await rail("internals").click();
  const hangarInternalSlots = await hangar.locator('.hangar-slot[data-kind="internal"]').count();
  expect(hangarWeaponSlots).toBeGreaterThan(0);
  expect(hangarInternalSlots).toBe(6); // five core internals + the auxiliary bay (2026-08-04 expansion)

  // Opening a bay slot shows its contextual module list: the rolling scroller,
  // with every row carrying its stat chips.
  await hangar.locator(".hangar-slot").last().click();
  await expect(hangar.locator(".hangar-picker")).toBeVisible();
  await expect(hangar.locator(".hangar-picker-list")).toBeVisible();
  await expect(hangar.locator(".hangar-picker-item .hangar-stat-chip").first()).toBeVisible();

  // The instrument strip reports the power rail as two bars against its max.
  await expect(hangar.locator(".hangar-statusbar .hangar-power-row")).toHaveCount(2);

  // ------------------------------------------------------- 4. back to lobby
  await hangar.locator(".hangar-close").click();
  await expect(lobby).toBeVisible();

  // ------------------------------------------------- 5. start a practice match
  await lobby.getByRole("button", { name: "Practice — Dummies", exact: true }).click();
  await expect(lobby).toBeHidden();

  // The loadout left in the Hangar is the one flown (owner 2026-07-31). Since
  // the starter-only defaults (2026-08-04), priced auxiliary sockets ship
  // empty, so the HUD shows a button per FITTED hardpoint module — fewer than
  // the hangar's socket count but never zero and never more than the sockets.
  const moduleButtons = page.locator(".hud-modules .hud-module-btn");
  await expect(moduleButtons).not.toHaveCount(0);
  expect(await moduleButtons.count()).toBeLessThanOrEqual(hangarWeaponSlots);
  await expect(page.locator(".hud-fps")).toHaveCount(0);

  // The dummies choice carries no explicit gamemode, so the match must still
  // resolve gamemode.practice's defaultArena — not the ring-nebula fallback
  // (regression: startMatch once defaulted the gamemode AFTER the arena lookup).
  expect(
    await page.evaluate(() => (window as unknown as { __debug: { session: { arenaId: string } } }).__debug.session.arenaId),
  ).toBe("arena.deep-field");

  // ----------------------------------------------------- 6. drive the match
  // Weapons spawn ONLINE (2026-07-31) and the support modules spawn retracted,
  // so the button row shows both states from the first frame.
  await expect(moduleButtons.first()).toHaveClass(/state-active/);

  // A real tap on the shield button issues a `moduleToggle` order; the module
  // leaves `retracted` via deploying → active (ModuleButtons.update mirrors the
  // sim state onto a `state-*` class). Found by name, not index: which
  // hardpoint carries the shield depends on the hull the Hangar left selected.
  const shieldModule = moduleButtons.filter({ hasText: "Shield" }).first();
  await expect(shieldModule).toHaveClass(/state-retracted/);
  await shieldModule.click();
  await expect(shieldModule).toHaveClass(/state-(deploying|active)/);
  await expect(shieldModule).not.toHaveClass(/state-retracted/);

  // A real LMB trigger edge must now produce real damage. First use ordinary
  // flight orders to settle the nose and wait for the armed module + server
  // lock; then dispatch the same pointer input a player uses on the canvas.
  const firingSolution = await page.evaluate<{
    ok: boolean;
    targetId: number;
    hull: number;
  } | null>(() => {
    const debug = (window as unknown as { __debug?: DebugApi }).__debug;
    if (!debug?.session) return null;
    const angleTo = (from: number, to: number): number => {
      let d = (to - from) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d <= -Math.PI) d += Math.PI * 2;
      return d;
    };
    for (let frame = 0; frame < 240; frame++) {
      const session = debug.session;
      if (!session) return null;
      const me = session.curSnapshot.ships.find((ship) => ship.id === session.playerId);
      const target = me
        ? session.curSnapshot.ships
            .filter((ship) => ship.team !== me.team)
            .sort(
              (a, b) =>
                Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) -
                Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z),
            )[0]
        : undefined;
      if (!me || !target) return null;
      const bearing = Math.atan2(target.pos.z - me.pos.z, target.pos.x - me.pos.x);
      session.order({
        kind: "flight",
        throttle: 0,
        turn: Math.max(-1, Math.min(1, angleTo(me.heading, bearing) * 2)),
        boost: false,
        fire: false,
      });
      debug.forceFrame(166);
      const currentMe = session.curSnapshot.ships.find((ship) => ship.id === session.playerId);
      const currentTarget = session.curSnapshot.ships.find((ship) => ship.id === target.id);
      if (
        currentMe?.locked &&
        currentMe.targetId === target.id &&
        currentMe.modules.some((module) => module.state === "active") &&
        currentTarget
      ) {
        return { ok: true, targetId: target.id, hull: currentTarget.hull };
      }
    }
    return null;
  });
  expect(firingSolution?.ok, "failed to arm a weapon and acquire the practice dummy").toBe(true);

  const canvas = page.locator("#renderCanvas");
  await canvas.dispatchEvent("pointerdown", {
    pointerId: 77,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
  });
  const hullAfterTrigger = await page.evaluate<number, { targetId: number; before: number }>(
    ({ targetId, before }) => {
      const debug = (window as unknown as { __debug?: DebugApi }).__debug;
      if (!debug?.session) return before;
      for (let frame = 0; frame < 80; frame++) {
        debug.forceFrame(166);
        const target = debug.session.curSnapshot.ships.find((ship) => ship.id === targetId);
        if (!target || target.hull < before) return target?.hull ?? 0;
      }
      return debug.session.curSnapshot.ships.find((ship) => ship.id === targetId)?.hull ?? before;
    },
    { targetId: firingSolution!.targetId, before: firingSolution!.hull },
  );
  await canvas.dispatchEvent("pointerup", {
    pointerId: 77,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
  });
  expect(hullAfterTrigger).toBeLessThan(firingSolution!.hull);

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
            fire: true,
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

  // Match presentation flow: a timed outcome banner yields to the MVP hero,
  // then NEXT reveals the full-viewport scoreboard with the exits below it.
  const results = page.locator(".hud-results");
  await expect(results).toHaveClass(/\bvisible\b/);
  await expect(results).toHaveClass(/hud-results--outcome/);
  // The 3 s banner advances on HUD frame dt; headless rAF is too throttled to
  // accumulate it in real time, so pump frames the same way the match did.
  await page.evaluate(async () => {
    const debug = (window as unknown as { __debug: { forceFrame(dtMs?: number): void } }).__debug;
    for (let i = 0; i < 80; i++) {
      debug.forceFrame(50);
      if (i % 10 === 9) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  await expect(results.locator("[data-results-action='next']")).toBeVisible({ timeout: 5000 });
  await expect(results.locator(".hud-results-title")).toHaveAttribute(
    "data-outcome",
    /^(victory|defeat|draw|cleared)$/,
  );
  await results.locator("[data-results-action='next']").click();
  await expect(page.locator(".hud-scoreboard")).toBeVisible();

  // ------------------------------------------------------ 8. back to the lobby
  // The scoreboard carries its own exits below the tables.
  await page.locator(".hud-scoreboard [data-results-action='menu']").click();
  await expect(lobby).toBeVisible();
  await expect(results).toHaveCount(0);

  expect(consoleErrors, `page reported errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
