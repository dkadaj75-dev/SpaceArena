/**
 * Persistent, dismissable warnings for the Ship Manager (4.6 Finding 7).
 *
 * These are DISTINCT from the editor's transient problem report: a successful
 * `configService.replace()` clears the transient report (`report(null)`) but must
 * NOT erase warnings about side effects the editor cannot undo — chiefly that
 * reordering hardpoints changes indices that player fittings in the DB reference.
 * Such warnings live here until the user explicitly dismisses them, and Save is
 * gated behind an explicit acknowledgement while any remain.
 */
export class StickyWarnings {
  private readonly items: string[] = [];
  private ack = false;

  /** Add a warning (deduplicated). Adding a NEW warning resets the acknowledgement. */
  add(message: string): void {
    if (this.items.includes(message)) return;
    this.items.push(message);
    this.ack = false;
  }

  /** Current warnings, in insertion order. */
  list(): readonly string[] {
    return this.items;
  }

  get hasWarnings(): boolean {
    return this.items.length > 0;
  }

  /** Remove one warning by index; resets acknowledgement when the list empties. */
  dismiss(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    if (this.items.length === 0) this.ack = false;
  }

  /** Clear all warnings and the acknowledgement. */
  dismissAll(): void {
    this.items.length = 0;
    this.ack = false;
  }

  get acknowledged(): boolean {
    return this.ack;
  }

  setAcknowledged(value: boolean): void {
    this.ack = value;
  }

  /** Save is allowed only when there are no warnings, or the user has acknowledged them. */
  get saveAllowed(): boolean {
    return this.items.length === 0 || this.ack;
  }
}
