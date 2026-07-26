/**
 * Marker attribute for interactive HUD elements.
 *
 * Historically this file also held the 5.4 edge palm-rejection rule for the
 * canvas pointer state machine. That machine retired with move orders
 * (FLIGHT.md §7): the chase camera takes no look-around gestures and there is
 * no tap-to-move, so the only touch surfaces left are the HUD's own DOM widgets,
 * which receive their contacts directly and have nothing to be rejected from.
 */

/** Marks a HUD element as an interactive control (styling + test/query hook). */
export const HUD_CONTROL_ATTR = "data-hud-control";
