/**
 * ROADMAP §10 5.7 — the shield shell's ANIMATION STATE MACHINE (owner
 * 2026-08-23). Four beats the owner asked the bubble to have, and the whole
 * point of pulling them out of the renderer is that they are a state machine
 * with real edges, which means they can be tested:
 *
 *   - RAISING: panels fly out of the hull and assemble into the shell.
 *   - LOWERING: the same sweep, played backwards.
 *   - BREAKING: the reservoir was shot flat — the shell blows apart, panels
 *     tumbling away on their own axes while the whole thing fades.
 *   - HIT: an absorb kicks an elastic wobble that is strongest around the point
 *     the shot came in on, plus the colour flare that already existed.
 *
 * The distinction that makes BREAKING possible without a new sim event: a
 * shield that goes down while its module is still `active` did not stand down,
 * it FLAMED OUT ({@link shieldBrokenBy}). A pilot retracting the module leaves
 * `active` first, so the two are never confused — and no gameplay state, wire
 * field or sim behaviour changed to tell them apart.
 *
 * Pure and Babylon-free; the renderer turns the poses below into thin-instance
 * matrices.
 */

import type { ShieldRippleSettings } from "./juiceSettings.js";
import type { ShieldPanel } from "./shieldPanels.js";

export type ShieldPhase = "down" | "assembling" | "up" | "standingDown" | "shattering";

export interface ShieldAnimState {
  phase: ShieldPhase;
  /** Milliseconds into the current phase. Meaningless (and 0) while `down` / `up`. */
  elapsedMs: number;
}

/** A shell that has never gone up. */
export function initialShieldAnim(): ShieldAnimState {
  return { phase: "down", elapsedMs: 0 };
}

/**
 * Whether a shield that just went down BROKE rather than stood down: at least
 * one shield module is still deployed, so nothing retracted — the reservoir
 * simply hit zero under fire. See the module header for why this is the honest
 * test rather than a new event.
 */
export function shieldBrokenBy(modules: readonly { state: string; shieldPool: number }[]): boolean {
  return modules.some((m) => m.state === "active" && m.shieldPool <= 0);
}

/**
 * Advance one shell by `dtMs`. `up` is the sim's own shield-shell signal and
 * `broken` is {@link shieldBrokenBy} sampled on the same frame; the state is
 * MUTATED and returned, so a shell costs no allocation per frame.
 *
 * The two mid-sweep reversals are the fiddly part and are deliberate: a shield
 * dropped halfway through assembling must fall back from where the panels
 * actually are, not snap out and re-collapse from the shell it never reached.
 * So a reversal carries its progress across rather than restarting the clock.
 */
export function advanceShieldAnim(
  state: ShieldAnimState,
  up: boolean,
  broken: boolean,
  dtMs: number,
  settings: ShieldRippleSettings,
): ShieldAnimState {
  const dt = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
  const assembleMs = settings.assembleMs > 0 ? settings.assembleMs : 1;
  const shatterMs = settings.shatterMs > 0 ? settings.shatterMs : 1;

  switch (state.phase) {
    case "down":
      if (up) {
        state.phase = "assembling";
        state.elapsedMs = 0;
      }
      return state;

    case "assembling":
      if (!up) {
        // A shield that broke while still coming up still broke: the pilot gets
        // the same "that just failed" read either way.
        if (broken) {
          state.phase = "shattering";
          state.elapsedMs = 0;
        } else {
          state.phase = "standingDown";
          // Mirror the progress so the panels continue from where they are.
          state.elapsedMs = Math.max(0, assembleMs - state.elapsedMs);
        }
        return state;
      }
      state.elapsedMs += dt;
      if (state.elapsedMs >= assembleMs) {
        state.phase = "up";
        state.elapsedMs = 0;
      }
      return state;

    case "up":
      if (!up) {
        state.phase = broken ? "shattering" : "standingDown";
        state.elapsedMs = 0;
      }
      return state;

    case "standingDown":
      if (up) {
        state.phase = "assembling";
        state.elapsedMs = Math.max(0, assembleMs - state.elapsedMs);
        return state;
      }
      state.elapsedMs += dt;
      if (state.elapsedMs >= assembleMs) {
        state.phase = "down";
        state.elapsedMs = 0;
      }
      return state;

    case "shattering":
      // A reservoir that recharges mid-blast starts a FRESH assembly: the panels
      // that flew off are gone, and dragging them back would read as the
      // explosion being sucked in again.
      if (up) {
        state.phase = "assembling";
        state.elapsedMs = 0;
        return state;
      }
      state.elapsedMs += dt;
      if (state.elapsedMs >= shatterMs) {
        state.phase = "down";
        state.elapsedMs = 0;
      }
      return state;
  }
}

/** Whether the renderer needs to draw anything at all this frame. */
export function shieldAnimVisible(state: ShieldAnimState): boolean {
  return state.phase !== "down";
}

/**
 * Whether the panel matrices have to be rewritten this frame. A shell sitting
 * at `up` is geometrically STATIC — its breathing and its impact flare are the
 * parent node's scale and the material's alpha, neither of which touches the
 * buffer — so ten idle shields cost ten node writes and no vertex traffic at
 * all. Only a moving phase, or a live bounce, pays.
 */
export function shieldAnimMoving(state: ShieldAnimState, bounce: number): boolean {
  return state.phase !== "up" || bounce > 0;
}

export interface PanelPose {
  /** Distance from the hull centre as a fraction of the bubble radius. */
  radial: number;
  /** Panel size multiplier; 0 means "not on screen". */
  scale: number;
  /** Radians of tumble about the panel's own jittered axis. */
  spinRad: number;
}

/**
 * How far into its own slice of the sweep panel `panel` is, 0..1. Panels start
 * at different times ({@link ShieldRippleSettings.assembleStagger}) so the shell
 * assembles as a scatter rather than as one popping ball — but every panel
 * still finishes by the end of the sweep, so the phase edge stays honest.
 */
export function panelProgress(panel: ShieldPanel, elapsedMs: number, settings: ShieldRippleSettings): number {
  const total = settings.assembleMs > 0 ? settings.assembleMs : 1;
  const stagger = Math.min(0.95, Math.max(0, settings.assembleStagger));
  const start = panel.jitter * stagger * total;
  const span = Math.max(1, total * (1 - stagger));
  return clamp01((elapsedMs - start) / span);
}

/**
 * Pose of one panel this frame, written into `out` (no allocation per panel per
 * frame — a hundred-odd of these run for every shield on screen).
 *
 * `bounce` is the shell-wide elastic wobble from {@link shieldBounce} already
 * weighted for this panel's distance from the impact point; the caller does the
 * weighting because it holds the impact direction.
 */
export function panelPose(
  panel: ShieldPanel,
  state: ShieldAnimState,
  settings: ShieldRippleSettings,
  bounce: number,
  out: PanelPose,
): void {
  switch (state.phase) {
    case "down":
      out.radial = 0;
      out.scale = 0;
      out.spinRad = 0;
      return;

    case "up":
      out.radial = 1 + bounce;
      out.scale = 1;
      out.spinRad = 0;
      return;

    case "assembling":
    case "standingDown": {
      // `standingDown` runs the same curve backwards: one shape of motion, so
      // the two directions cannot drift apart when the curve is retuned.
      const raw = panelProgress(panel, state.elapsedMs, settings);
      const p = state.phase === "assembling" ? raw : 1 - raw;
      // Panels start INSIDE the hull and overshoot slightly on arrival — the
      // "assembled with a snap" read, and the reason this is a back-ease.
      out.radial = easeOutBack(p) * (1 - HULL_SEAT) + HULL_SEAT;
      out.scale = p;
      // A little unwinding spin, gone by the time the panel seats.
      out.spinRad = (1 - p) * ASSEMBLE_SPIN_RAD * (panel.speed - 0.5);
      return;
    }

    case "shattering": {
      const p = clamp01(state.elapsedMs / (settings.shatterMs > 0 ? settings.shatterMs : 1));
      // Constant outward speed with a slight ease-out: debris in vacuum does
      // not decelerate, but a panel that shrinks as it goes reads as "gone"
      // instead of as "still out there, very small".
      out.radial = 1 + settings.shatterSpeed * panel.speed * p;
      out.scale = 1 - p * p;
      out.spinRad = p * SHATTER_SPIN_RAD * panel.speed;
      return;
    }
  }
}

/**
 * Shell-wide opacity multiplier for the phase — layered ON TOP of the theme's
 * alpha band so the tuned transparency is preserved exactly at rest. Only the
 * shatter fades: assembling and standing down are already legible through the
 * panels' own scale.
 */
export function phaseAlphaScale(state: ShieldAnimState, settings: ShieldRippleSettings): number {
  if (state.phase !== "shattering") return 1;
  const p = clamp01(state.elapsedMs / (settings.shatterMs > 0 ? settings.shatterMs : 1));
  return 1 - p;
}

/**
 * The elastic "bounce" an absorb kicks into the shell, 0..peak, `msSinceImpact`
 * after the hit. A damped cosine rather than the squared falloff the colour
 * flare uses: the flare is a flash and wants to be gone, the bounce is a
 * membrane and wants to overshoot, come back past its rest radius, and settle.
 *
 * Shares the flare's `impactDecayMs` clock deliberately — one hit, one felt
 * duration, whichever channel the player reads it through.
 */
export function shieldBounce(msSinceImpact: number, settings: ShieldRippleSettings): number {
  if (!Number.isFinite(msSinceImpact) || settings.impactDecayMs <= 0) return 0;
  const age = Math.max(0, msSinceImpact);
  if (age >= settings.impactDecayMs) return 0;
  const t = age / settings.impactDecayMs;
  // Two wobbles across the decay, amplitude falling off quadratically.
  const damp = (1 - t) * (1 - t);
  return settings.hitBounce * damp * Math.cos(2 * Math.PI * BOUNCE_CYCLES * t);
}

/**
 * How much of the shell's bounce this panel takes, from how squarely it faces
 * the incoming shot. `dot` is the panel normal against the unit direction the
 * hit came FROM; `hitFocus` sharpens the falloff, and 0 spreads the wobble over
 * the whole bubble (which is also what a hit with no known direction gets).
 */
export function panelBounceWeight(dot: number, settings: ShieldRippleSettings): number {
  if (settings.hitFocus <= 0) return 1;
  const facing = Math.max(0, dot);
  return Math.pow(facing, settings.hitFocus);
}

/** Where a panel sits while still stowed, as a fraction of the bubble radius. */
const HULL_SEAT = 0.12;
/** Radians of unwinding spin a panel carries at the very start of its sweep. */
const ASSEMBLE_SPIN_RAD = Math.PI * 1.4;
/** Radians a shattered panel tumbles across the whole blast. */
const SHATTER_SPIN_RAD = Math.PI * 6;
/** Wobbles the bounce makes before it settles. */
const BOUNCE_CYCLES = 1.75;

/** Back-ease with a modest overshoot — the panel snapping into its seat. */
function easeOutBack(t: number): number {
  const c = 1.7;
  const x = clamp01(t) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
