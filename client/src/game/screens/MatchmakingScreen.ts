import type { ConfigEvents, ConfigService, EventBus, ThemeConfig } from "@space-arena/shared";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";

const THEME_ID = "theme.default";
const DEFAULT_LINES = [
  "Looking for a worthy opponent...",
  "Scanning nearby sectors...",
  "Polishing the hull...",
  "Calibrating targeting arrays...",
] as const;

export type MatchmakingScreenState =
  | "hidden"
  | "searching"
  | "found"
  | "joining"
  | "interrupted"
  | "server-lost";

export interface MatchmakingScreenCallbacks {
  onCancel: () => void;
  onBack: () => void;
  onRetry: () => void;
}

/** Sci-fi search presentation plus its deliberately small UI state machine. */
export class MatchmakingScreen {
  private readonly root: HTMLDivElement;
  private readonly headline: HTMLHeadingElement;
  private readonly flavor: HTMLDivElement;
  private readonly elapsed: HTMLDivElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly unsubscribeTheme: (() => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private lineIndex = 0;
  private lines: readonly string[] = DEFAULT_LINES;
  private rotationMs = 4000;
  private stateValue: MatchmakingScreenState = "hidden";

  constructor(
    parent: HTMLElement,
    private readonly configs: ConfigService,
    callbacks: MatchmakingScreenCallbacks,
    bus?: EventBus<ConfigEvents>,
  ) {
    injectScreenStyle();
    this.root = document.createElement("div");
    this.root.className = "sa-screen sa-menu sa-matchmaking";
    this.root.style.zIndex = "24";
    this.root.style.display = "none";
    this.root.append(createMenuBackdrop());

    const panel = document.createElement("div");
    panel.className = "sa-matchmaking-panel";
    const scanner = document.createElement("div");
    scanner.className = "sa-matchmaking-scanner";
    scanner.setAttribute("aria-hidden", "true");
    scanner.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));

    this.headline = document.createElement("h1");
    this.headline.className = "sa-screen-title";
    this.flavor = document.createElement("div");
    this.flavor.className = "sa-matchmaking-flavor";
    this.flavor.setAttribute("role", "status");
    this.elapsed = document.createElement("div");
    this.elapsed.className = "sa-matchmaking-elapsed";

    this.cancelButton = button("Cancel", () => {
      this.hide();
      callbacks.onCancel();
    });
    this.cancelButton.dataset["matchmakingAction"] = "cancel";
    this.backButton = button("Back to Lobby", () => {
      this.hide();
      callbacks.onBack();
    });
    this.backButton.dataset["matchmakingAction"] = "back";
    this.retryButton = button("Retry Search", () => callbacks.onRetry());
    this.retryButton.dataset["matchmakingAction"] = "retry";
    panel.append(
      scanner,
      this.headline,
      this.flavor,
      this.elapsed,
      this.cancelButton,
      this.retryButton,
      this.backButton,
    );
    this.root.append(panel);
    parent.append(this.root);

    this.applyTheme();
    this.unsubscribeTheme = bus?.on("config:changed", (event) => {
      if (event.type === "theme") this.applyTheme();
    }) ?? null;
  }

  get state(): MatchmakingScreenState {
    return this.stateValue;
  }

  begin(now = Date.now()): void {
    this.startedAt = now;
    this.lineIndex = 0;
    this.transition("searching", "Looking for a worthy opponent", this.lines[0] ?? DEFAULT_LINES[0]);
    this.root.style.display = "flex";
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), 250);
    this.tick(now);
  }

  found(opponentName: string): void {
    this.transition("found", `Opponent found: ${opponentName}`, "Signal locked. Preparing combat link.");
  }

  joining(): void {
    this.transition("joining", "Joining duel", "Synchronizing arena telemetry...");
  }

  serverLost(): void {
    this.stopTimer();
    this.transition("server-lost", "Connection lost", "The arena server stopped responding. Return to the lobby and try again.");
  }

  interrupted(): void {
    this.stopTimer();
    this.transition(
      "interrupted",
      "Search interrupted — tap to retry",
      "Your queue entry expired while this tab was in the background.",
    );
  }

  hide(): void {
    this.stopTimer();
    this.stateValue = "hidden";
    this.root.dataset["state"] = "hidden";
    this.root.style.display = "none";
  }

  private transition(state: MatchmakingScreenState, headline: string, flavor: string): void {
    this.stateValue = state;
    this.root.dataset["state"] = state;
    this.headline.textContent = headline;
    this.flavor.textContent = flavor;
    this.cancelButton.hidden = state !== "searching";
    this.retryButton.hidden = state !== "interrupted";
    this.backButton.hidden = state !== "server-lost";
    this.elapsed.hidden = state === "server-lost" || state === "interrupted";
  }

  private tick(now = Date.now()): void {
    if (this.stateValue !== "searching") return;
    const elapsedMs = Math.max(0, now - this.startedAt);
    this.elapsed.textContent = `SEARCH TIME  ${formatElapsed(elapsedMs)}`;
    const nextIndex = Math.floor(elapsedMs / this.rotationMs) % this.lines.length;
    if (nextIndex !== this.lineIndex) {
      this.lineIndex = nextIndex;
      this.flavor.textContent = this.lines[nextIndex]!;
    }
  }

  private applyTheme(): void {
    const theme = this.configs.get<ThemeConfig>("theme", THEME_ID);
    applyMenuTheme(this.root, theme);
    const matchmaking = theme?.menu?.matchmaking;
    this.lines = matchmaking?.flavorLines?.length ? matchmaking.flavorLines : DEFAULT_LINES;
    this.rotationMs = matchmaking?.flavorRotationMs ?? 4000;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stopTimer();
    this.unsubscribeTheme?.();
    this.root.remove();
  }
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = "sa-screen-btn sa-button sa-button--secondary";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}
