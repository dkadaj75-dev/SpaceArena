import { createLogger, type ConfigService, type GamemodeConfig } from "@space-arena/shared";

const log = createLogger("Lobby");

export type LobbyChoice =
  | { kind: "practice" }
  | { kind: "online"; gamemode: string; options?: { practiceTarget?: boolean; minPlayers?: number } };

/**
 * Minimal pre-match overlay (ROADMAP §7 2.8 client): mode buttons generated
 * from gamemode configs plus an offline practice entry. Phase 5 restyles this.
 */
export class Lobby {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly buttons: HTMLButtonElement[] = [];

  constructor(
    parent: HTMLElement,
    private readonly configs: ConfigService,
    private readonly onChoose: (choice: LobbyChoice) => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "lobby-overlay";
    this.root.style.cssText =
      "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
      "background:rgba(4,8,16,.88);z-index:20;color:#e8f1ff;font-family:system-ui";

    const title = document.createElement("h1");
    title.textContent = "SPACE ARENA";
    title.style.cssText = "letter-spacing:.3em;font-weight:300;color:#57d8ff;margin:0 0 18px";
    this.root.append(title);

    this.addButton("Practice (offline)", () => this.choose({ kind: "practice" }));
    for (const gm of this.configs.getAll<GamemodeConfig>("gamemode")) {
      if (gm.id === "gamemode.practice") continue;
      this.addButton(`Play Online — ${gm.name ?? gm.id}`, () => this.choose({ kind: "online", gamemode: gm.id }));
    }
    this.addButton("Online solo test (vs dummies)", () =>
      this.choose({ kind: "online", gamemode: "gamemode.duel-1v1", options: { practiceTarget: true, minPlayers: 1 } }),
    );

    this.status = document.createElement("div");
    this.status.style.cssText = "min-height:1.4em;color:#9fb4d0";
    this.root.append(this.status);

    parent.append(this.root);
  }

  private addButton(label: string, onClick: () => void): void {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "min-width:280px;padding:12px 24px;font-size:16px;background:#12203a;color:#e8f1ff;" +
      "border:1px solid #2f6fb8;border-radius:8px;cursor:pointer";
    b.addEventListener("click", onClick);
    this.buttons.push(b);
    this.root.append(b);
  }

  private choose(choice: LobbyChoice): void {
    log.info("choice", choice);
    this.setBusy(true, choice.kind === "online" ? "Connecting…" : "");
    this.onChoose(choice);
  }

  setBusy(busy: boolean, message = ""): void {
    for (const b of this.buttons) b.disabled = busy;
    this.status.textContent = message;
  }

  showError(message: string): void {
    this.setBusy(false, `⚠ ${message}`);
  }

  show(): void {
    this.root.style.display = "flex";
    this.setBusy(false, "");
  }
  hide(): void {
    this.root.style.display = "none";
  }
  dispose(): void {
    this.root.remove();
  }
}
