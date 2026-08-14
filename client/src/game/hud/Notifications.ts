import type { ActionConfig, ConfigService, NotificationConfig, SimEvent, ThemeConfig, TuningConfig } from "@space-arena/shared";
import { createLogger, heatSystemEnabled } from "@space-arena/shared";

const log = createLogger("HudNotifications");

interface Toast {
  el: HTMLDivElement;
  remainingMs: number;
}

/**
 * Toast queue for notifications resolved from sim-event action ids (§6 1.8).
 * `SimEvent`s carry `actions?: string[]` action-config ids (e.g. the
 * `onOverheat` hook fires `action.notify-overheat`); any action whose `kind`
 * is `show_notification` resolves its `params.notification` config and toasts
 * it. Max `notificationMaxVisible` (theme config) shown at once; overflow is
 * simply dropped rather than queued indefinitely, since these are ambient
 * combat callouts, not a message log.
 */
export class NotificationCenter {
  private readonly container: HTMLDivElement;
  private readonly toasts: Toast[] = [];
  private maxVisible = 3;

  constructor(root: HTMLElement, configs: ConfigService) {
    this.container = document.createElement("div");
    this.container.className = "hud-notifications";
    root.appendChild(this.container);

    const theme = configs.get<ThemeConfig>("theme", "theme.default");
    this.maxVisible = theme?.hud?.notificationMaxVisible ?? 3;
  }

  consumeEvents(events: readonly SimEvent[], configs: ConfigService): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === "overheated" && !heatSystemEnabled(configs.getAll<TuningConfig>("tuning")[0] ?? ({} as TuningConfig))) continue;
      const actions = (ev as { actions?: string[] }).actions;
      if (!actions || actions.length === 0) continue;
      for (const actionId of actions) {
        this.tryShowNotificationFor(configs, actionId);
      }
    }
  }

  private tryShowNotificationFor(configs: ConfigService, actionId: string): void {
    const action = configs.get<ActionConfig>("action", actionId);
    if (!action || action.kind !== "show_notification") return;
    const notifId = action.params?.["notification"];
    if (typeof notifId !== "string") return;
    const notif = configs.get<NotificationConfig>("notification", notifId);
    if (!notif) {
      log.warn(`unknown notification config ${notifId}`);
      return;
    }
    this.show(notif);
  }

  /** Direct client-side toast (e.g. rejected order feedback) — no config needed. */
  showText(text: string, style = "warning", durationMs = 2500): void {
    this.show({ text, style, durationMs } as NotificationConfig);
  }

  /** Resolve and show one authored notification through the same toast path. */
  showConfig(configs: ConfigService, notificationId: string): void {
    const notif = configs.get<NotificationConfig>("notification", notificationId);
    if (!notif) {
      log.warn(`unknown notification config ${notificationId}`);
      return;
    }
    this.show(notif);
  }

  private show(notif: NotificationConfig): void {
    if (this.toasts.length >= this.maxVisible) {
      const oldest = this.toasts.shift();
      oldest?.el.remove();
    }
    const el = document.createElement("div");
    el.className = `hud-toast ${notif.style}`;
    el.textContent = notif.text;
    this.container.appendChild(el);
    this.toasts.push({ el, remainingMs: notif.durationMs });
  }

  update(dtMs: number): void {
    if (this.toasts.length === 0) return;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i]!;
      t.remainingMs -= dtMs;
      if (t.remainingMs <= 0) {
        t.el.remove();
        this.toasts.splice(i, 1);
      }
    }
  }

  dispose(): void {
    this.container.remove();
    this.toasts.length = 0;
  }
}
