import type { NetGameSession } from "./NetGameSession.js";

/** DEV-only compact net telemetry; F9 toggles it. */
export class NetDebugOverlay {
  private readonly el: HTMLPreElement;
  private visible = false;
  private readonly keydown = (event: KeyboardEvent) => { if (event.key === "F9") { event.preventDefault(); this.visible = !this.visible; this.el.hidden = !this.visible; } };
  constructor(private readonly session: NetGameSession) {
    this.el = document.createElement("pre"); this.el.style.cssText = "position:fixed;right:8px;top:8px;z-index:30;color:#9ef;background:#001c;padding:8px;margin:0;pointer-events:none"; this.el.hidden = true;
    document.body.appendChild(this.el); window.addEventListener("keydown", this.keydown);
  }
  update(): void {
    if (!this.visible) return;
    const s = this.session;
    this.el.textContent =
      `net ${s.net.connected ? "connected" : "closed"}\n` +
      `rtt ${s.rttMs.toFixed(0)}ms  patches ${s.patchesPerSec.toFixed(1)}/s (${s.patchesReceived})\n` +
      `buffer ${s.bufferDepth} snaps\n` +
      `orders ${s.ordersSent} sent / ${s.ordersAcked} ack / ${s.ordersRejected} rej\n` +
      `correction ${s.correctionError.toFixed(2)}u`;
  }
  dispose(): void { window.removeEventListener("keydown", this.keydown); this.el.remove(); }
}
