/**
 * Desktop LMB trigger bound to the live game canvas. It deliberately does not
 * capture the pointer: RMB steering may already own the mouse pointer, and a
 * pointer-locked canvas continues to receive the LMB edge.
 */
export class CanvasFireInput {
  private down = false;
  private enabled = true;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (!this.enabled || ev.pointerType !== "mouse" || ev.button !== 0) return;
    this.down = true;
    ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerType !== "mouse" || ev.button !== 0) return;
    this.down = false;
  };

  private readonly onBlur = (): void => {
    this.down = false;
  };

  constructor(private readonly surface: HTMLElement) {
    surface.addEventListener("pointerdown", this.onPointerDown);
    // Release may occur just outside an unlocked canvas. Document-level edges
    // prevent a stuck trigger without taking pointer capture away from steering.
    document.addEventListener("pointerup", this.onPointerUp);
    document.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("blur", this.onBlur);
  }

  get held(): boolean {
    return this.down;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.down = false;
  }

  dispose(): void {
    this.surface.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("blur", this.onBlur);
  }
}
