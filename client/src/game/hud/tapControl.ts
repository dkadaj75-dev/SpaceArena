/**
 * TAP BINDING for HUD controls (2026-08-23).
 *
 * ## The bug this exists for
 *
 * A phone pilot steers by holding a thumb on the screen. While that first touch
 * point is down, a SECOND touch on a button does not synthesize a `click`:
 * browsers only generate the compatibility mouse events for a single-touch
 * gesture. Every `click`-bound HUD control was therefore DEAD for the whole of
 * normal flight — the shield toggle, the SCORE button and the settings gear all
 * did nothing while steering, which the match playtest confirmed live (the
 * shield never left `state-retracted` across an entire CTF match). The weapon
 * triggers, BOOST and JETTISON were unaffected precisely because they are bound
 * to pointer events.
 *
 * ## What a tap is here
 *
 * Press and release the SAME pointer on the SAME element, having moved less
 * than {@link TAP_MOVE_TOLERANCE_PX}. The move tolerance is what keeps a drag
 * that happens to start on a button from firing it — a pilot's thumb slides.
 *
 * `click` stays bound for KEYBOARD and assistive activation only, which is
 * distinguishable without heuristics: a UA-synthesized click from Enter/Space
 * on a `<button>` carries `detail === 0`, while a pointer-driven click carries
 * the click count. That keeps one handler for both worlds and cannot double-fire.
 */

/** How far a pointer may travel between press and release and still be a tap. */
export const TAP_MOVE_TOLERANCE_PX = 12;

export interface TapOptions {
  /** Override the move tolerance (px). */
  tolerancePx?: number;
}

/**
 * Bind `handler` to a tap on `el`. Returns an unbind function.
 *
 * Deliberately NOT using pointer capture: without it, a release that happens
 * off the element simply never reaches this listener, which is the "slid off
 * the button, changed my mind" behaviour a button should have.
 */
export function bindTap(
  el: HTMLElement,
  handler: (event: Event) => void,
  options: TapOptions = {},
): () => void {
  const tolerance = options.tolerancePx ?? TAP_MOVE_TOLERANCE_PX;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;

  const onPointerDown = (ev: PointerEvent): void => {
    // First finger down wins; a second one landing on the same button while the
    // first is held is not a new press.
    if (pointerId !== null) return;
    pointerId = ev.pointerId;
    startX = coord(ev.clientX);
    startY = coord(ev.clientY);
  };
  const onPointerUp = (ev: PointerEvent): void => {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    pointerId = null;
    if (Math.hypot(coord(ev.clientX) - startX, coord(ev.clientY) - startY) > tolerance) return;
    handler(ev);
  };
  const onPointerCancel = (ev: PointerEvent): void => {
    if (ev.pointerId === pointerId) pointerId = null;
  };
  const onClick = (ev: MouseEvent): void => {
    // Keyboard/AT only — see the note above. A pointer-driven click reports its
    // click COUNT in `detail` and has already been handled on pointerup;
    // anything that does not report one (Enter/Space, AT activation, a
    // programmatic `el.click()`) is the path this branch exists for.
    if (!(ev.detail > 0)) handler(ev);
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("click", onClick);
  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    el.removeEventListener("click", onClick);
  };
}

/**
 * jsdom's synthetic events carry no coordinates, and `undefined - 0` is NaN —
 * which would make every test tap read as a drag past the tolerance.
 */
function coord(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}
