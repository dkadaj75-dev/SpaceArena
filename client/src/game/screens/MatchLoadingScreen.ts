import type { ArenaConfig, ConfigEvents, ConfigService, EventBus, ThemeConfig } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { applyMenuTheme, injectScreenStyle } from "./screenStyle.js";

const STYLE_ID = "sa-match-loading-style";
export const DEFAULT_MATCH_LOADING_MIN_VISIBLE_MS = 1500;

/** Theme-authored loading-card hold, with a safe default for older content packs. */
export function matchLoadingMinVisibleMs(theme: ThemeConfig | undefined): number {
  const authored = theme?.menu?.matchLoadingMinVisibleMs;
  return typeof authored === "number" && Number.isFinite(authored) && authored >= 0
    ? authored
    : DEFAULT_MATCH_LOADING_MIN_VISIBLE_MS;
}

export interface LoadingRosterEntry { team: number; name: string }

/** Snapshot the already-built roster so online replication and offline bots share one renderer. */
export function loadingRoster(session: GameSession): LoadingRosterEntry[] {
  return session.curSnapshot.ships.map((ship) => ({
    team: ship.team,
    name: session.displayNameFor(ship.id)
      ?? (ship.id === session.playerId ? "YOU" : `PILOT ${ship.id}`),
  }));
}

export class MatchLoadingScreen {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly teams: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly unsubscribe: (() => void) | null;
  private shownAtMs: number | null = null;

  constructor(parent: HTMLElement, private readonly configs: ConfigService, bus?: EventBus<ConfigEvents>) {
    injectScreenStyle();
    injectStyle();
    this.root = document.createElement("div");
    this.root.className = "sa-screen sa-match-loading";
    this.root.style.display = "none";
    this.root.style.zIndex = "26";
    const shade = document.createElement("div"); shade.className = "sa-match-loading-shade";
    const panel = document.createElement("section"); panel.className = "sa-match-loading-panel";
    const kicker = document.createElement("div"); kicker.className = "sa-match-loading-kicker"; kicker.textContent = "PREPARING ARENA";
    this.title = document.createElement("h1"); this.title.className = "sa-screen-title";
    this.teams = document.createElement("div"); this.teams.className = "sa-match-loading-teams";
    this.status = document.createElement("div"); this.status.className = "sa-match-loading-status"; this.status.innerHTML = '<span aria-hidden="true"></span> Loading combat systems';
    panel.append(kicker, this.title, this.teams, this.status);
    this.root.append(shade, panel); parent.append(this.root);
    this.applyTheme();
    this.unsubscribe = bus?.on("config:changed", (event) => { if (event.type === "theme") this.applyTheme(); }) ?? null;
  }

  showPending(label = "Connecting to arena"): void {
    this.title.textContent = label;
    this.teams.replaceChildren();
    this.root.style.removeProperty("--sa-loading-art");
    this.root.style.display = "flex";
  }

  showSession(session: GameSession, contentBase: string): void {
    const arena = this.configs.get<ArenaConfig>("arena", session.arenaId);
    this.title.textContent = arena?.name ?? session.arenaId;
    if (arena?.render?.skybox.texture) {
      this.root.style.setProperty("--sa-loading-art", `url("${contentBase}content/${arena.render.skybox.texture}")`);
    }
    renderRoster(this.teams, loadingRoster(session));
    this.root.style.display = "flex";
    // Pending connection copy is intentionally not counted: this is the map,
    // art, and roster beat that must remain visible after preload resolves.
    this.shownAtMs = performance.now();
  }

  /** Hold the resolved loading card for its theme duration, then dismiss it. */
  async dismiss(): Promise<void> {
    const elapsed = this.shownAtMs === null ? 0 : performance.now() - this.shownAtMs;
    const theme = this.configs.get<ThemeConfig>("theme", "theme.default");
    const remaining = Math.max(0, matchLoadingMinVisibleMs(theme) - elapsed);
    if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
    this.hide();
  }

  hide(): void { this.shownAtMs = null; this.root.style.display = "none"; }
  dispose(): void { this.unsubscribe?.(); this.root.remove(); }
  private applyTheme(): void { applyMenuTheme(this.root, this.configs.get<ThemeConfig>("theme", "theme.default")); }
}

export function renderRoster(host: HTMLElement, roster: readonly LoadingRosterEntry[]): void {
  host.replaceChildren();
  const teams = new Map<number, string[]>();
  for (const entry of roster) {
    const names = teams.get(entry.team) ?? [];
    names.push(entry.name);
    teams.set(entry.team, names);
  }
  for (const [team, names] of [...teams].sort((a, b) => a[0] - b[0])) {
    const group = document.createElement("section"); group.className = "sa-match-loading-team"; group.dataset["team"] = String(team);
    const heading = document.createElement("h2"); heading.textContent = `TEAM ${team + 1}`; group.append(heading);
    for (const name of names) { const pilot = document.createElement("div"); pilot.className = "sa-match-loading-pilot"; pilot.textContent = name; group.append(pilot); }
    host.append(group);
  }
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style"); style.id = STYLE_ID; style.textContent = `
.sa-match-loading{isolation:isolate;background:#050814;overflow:hidden;padding:clamp(18px,5vw,64px)}
.sa-match-loading::before{content:"";position:absolute;inset:-24px;background-image:var(--sa-loading-art);background-size:cover;background-position:center;filter:blur(12px);transform:scale(1.06);z-index:-2}
.sa-match-loading-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(3,7,17,.54),rgba(3,7,17,.9) 72%,rgba(3,7,17,.98));z-index:-1}
.sa-match-loading-panel{width:min(920px,100%);margin:auto;text-align:center}
.sa-match-loading-kicker{color:var(--sa-menu-accent,#ffb35c);font-size:.72rem;letter-spacing:.34em;margin-bottom:10px}
.sa-match-loading-teams{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:clamp(12px,3vw,28px);margin:clamp(20px,5vh,44px) 0}
.sa-match-loading-team{padding:clamp(14px,3vw,24px);background:color-mix(in srgb,var(--sa-menu-panel,#0c1730) 82%,transparent);border:1px solid color-mix(in srgb,var(--sa-menu-primary,#39bfff) 45%,transparent);clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}
.sa-match-loading-team h2{margin:0 0 12px;color:var(--sa-menu-primary,#39bfff);font-size:.76rem;letter-spacing:.22em}
.sa-match-loading-pilot{padding:7px;overflow-wrap:anywhere;color:var(--sa-menu-text,#dbe9ff)}
.sa-match-loading-status{color:var(--sa-menu-muted,#8ba3c4);font-size:.78rem;letter-spacing:.12em}
.sa-match-loading-status span{display:inline-block;width:12px;height:12px;margin-right:9px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sa-loading-spin .8s linear infinite;vertical-align:-2px}
@keyframes sa-loading-spin{to{transform:rotate(360deg)}}
@media(max-width:520px){.sa-match-loading-teams{grid-template-columns:1fr;max-height:48vh;overflow:auto}.sa-match-loading{padding-top:max(18px,env(safe-area-inset-top))}}
`;
  document.head.append(style);
}
