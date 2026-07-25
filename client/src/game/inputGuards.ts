/**
 * Pure guards for the §2.2 pointer state machine (5.4 touch hardening).
 *
 * Kept free of Babylon/DOM globals so the palm-rejection rule is unit-testable
 * and identical between the tactical camera's gesture path and
 * {@link import("./OrderInput.js").OrderInput}'s tap path.
 */

/** Marks a HUD element as an interactive control that palm rejection must never eat. */
export const HUD_CONTROL_ATTR = "data-hud-control";

export interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * True when a pointer landed inside `marginPx` of any edge of the input
 * surface. Phones register palm/finger-heel contacts along the bezels while the
 * thumb works the middle of the screen; those contacts must not become move
 * orders. A margin of 0 disables rejection entirely.
 */
export function isEdgeContact(clientX: number, clientY: number, rect: SurfaceRect, marginPx: number): boolean {
  if (marginPx <= 0) return false;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return x < marginPx || y < marginPx || x > rect.width - marginPx || y > rect.height - marginPx;
}

/**
 * True when the event landed on (or inside) a HUD control — module buttons and
 * anything tagged {@link HUD_CONTROL_ATTR}. Such a press is deliberate no
 * matter how close to the bezel it is, so it is exempt from edge rejection.
 */
export function isHudControlTarget(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(`[${HUD_CONTROL_ATTR}]`) !== null;
}

/**
 * The palm-rejection decision for one POINTERDOWN. A rejected pointer is
 * dropped from tap tracking entirely (it does not even count toward the
 * multi-touch tally), so a palm resting on the bezel can never suppress the
 * legitimate thumb tap that follows it.
 */
export function shouldRejectContact(
  clientX: number,
  clientY: number,
  target: unknown,
  rect: SurfaceRect,
  marginPx: number,
): boolean {
  if (isHudControlTarget(target)) return false;
  return isEdgeContact(clientX, clientY, rect, marginPx);
}
