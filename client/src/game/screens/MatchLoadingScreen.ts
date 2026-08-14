import type {
  ArenaConfig,
  ConfigEvents,
  ConfigService,
  EventBus,
  Snapshot,
  ThemeConfig,
} from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { applyMenuTheme, injectScreenStyle } from "./screenStyle.js";

const STYLE_ID = "sa-match-loading-style";
export const DEFAULT_MATCH_LOADING_MIN_VISIBLE_MS = 1500;

/** Count-up refresh cadence — a whole second only ever ticks once on screen. */
const ELAPSED_TICK_MS = 250;

/** Copy used while a pack authors no `theme.menu.matchmaking.flavorLines`. */
const DEFAULT_SEARCH_LINES = [
  "Scanning nearby sectors...",
  "Hailing available pilots...",
  "Warming the launch rails...",
] as const;

/** Theme-authored loading-card hold, with a safe default for older content packs. */
export function matchLoadingMinVisibleMs(theme: ThemeConfig | undefined): number {
  const authored = theme?.menu?.matchLoadingMinVisibleMs;
  return typeof authored === "number" && Number.isFinite(authored) && authored >= 0
    ? authored
    : DEFAULT_MATCH_LOADING_MIN_VISIBLE_MS;
}

/**
 * What a roster row IS, rather than how it looks: the local pilot, another
 * human, or a bot the room filled a slot with. The renderer is the only thing
 * that turns these into colours and tags.
 */
export type LoadingRosterKind = "you" | "player" | "bot";

export interface LoadingRosterEntry {
  team: number;
  name: string;
  kind?: LoadingRosterKind;
}

/** The three phases this one screen presents, in the order a match meets them. */
export type MatchLoadingPhase = "pending" | "searching" | "ready";

export interface MatchSearchOptions {
  /** Pilots per team the room is trying to seat — drives the empty slot rows. */
  teamSize: number;
  /** Headline while searching (the arena the match is expected to run on). */
  title?: string;
  /** Backdrop art for that arena, as a ready-to-use CSS url() value. */
  art?: string | null;
  /** Offered as a "Cancel" control while the search is live. Omitted ⇒ no button. */
  onCancel?: (() => void) | undefined;
}

/**
 * Snapshot the already-built roster so online replication and offline bots share
 * one renderer. Reads {@link GameSession.rosterSnapshot} rather than
 * `curSnapshot`: before a match runtime exists nothing ticks the session, so the
 * interpolated pair is still the first patch — the newest AUTHORITATIVE state is
 * what the lobby roster has to be drawn from.
 */
export function loadingRoster(
  session: GameSession,
  snapshot: Snapshot = session.rosterSnapshot,
): LoadingRosterEntry[] {
  return snapshot.ships.map((ship) => ({
    team: ship.team,
    name:
      session.displayNameFor(ship.id) ??
      (ship.id === session.playerId ? "YOU" : `PILOT ${ship.id}`),
    kind: ship.id === session.playerId ? "you" : session.isBotFor(ship.id) ? "bot" : "player",
  }));
}

/**
 * Elapsed search time as `m:ss` — a count **UP** from zero, never a countdown.
 * Minutes are unpadded (`0:07`, `1:05`) so the number reads as "how long have I
 * been waiting", not as a deadline.
 */
export function formatCountUp(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One team column: the pilots seated so far plus the slots still open. */
export interface RosterTeamView {
  team: number;
  filled: LoadingRosterEntry[];
  /** Open slots, i.e. `teamSize - filled.length` (0 when no team size is known). */
  empty: number;
}

/**
 * Group a flat roster into ordered team columns. A known `teamSize` also seeds
 * BOTH teams even when nobody has joined the far side yet: an empty enemy column
 * is the honest picture of "still looking", and it stops the layout jumping from
 * one column to two the moment an opponent lands.
 */
export function rosterTeams(
  roster: readonly LoadingRosterEntry[],
  teamSize = 0,
): RosterTeamView[] {
  const byTeam = new Map<number, LoadingRosterEntry[]>();
  if (teamSize > 0) {
    byTeam.set(0, []);
    byTeam.set(1, []);
  }
  for (const entry of roster) {
    const names = byTeam.get(entry.team) ?? [];
    names.push(entry);
    byTeam.set(entry.team, names);
  }
  return [...byTeam]
    .sort((a, b) => a[0] - b[0])
    .map(([team, filled]) => ({ team, filled, empty: Math.max(0, teamSize - filled.length) }));
}

/**
 * Match launch presentation (loading + matchmaking in ONE screen).
 *
 * Ordering is the point: an online match shows `searching` FIRST — a count-up
 * clock and both team rosters that fill in as real pilots (and then the room's
 * backfill bots) arrive — while the arena scene and its models load in the
 * background. Only when the room reports it is no longer `waiting` does the card
 * settle into `ready`, showing whatever preload is left. Offline practice uses
 * the same screen with a roster that is complete from the first frame.
 */
export class MatchLoadingScreen {
  private readonly root: HTMLDivElement;
  private readonly kicker: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly elapsed: HTMLDivElement;
  private readonly teams: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly statusText: HTMLSpanElement;
  private readonly progress: HTMLDivElement;
  private readonly progressBar: HTMLDivElement;
  private readonly progressLabel: HTMLDivElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly unsubscribe: (() => void) | null;
  private shownAtMs: number | null = null;
  private phaseValue: MatchLoadingPhase = "pending";
  private searchStartedAt = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private teamSize = 0;
  /** Serialized roster, so a 20 Hz patch stream does not rebuild the DOM. */
  private rosterKey = "";
  private onCancel: (() => void) | null = null;
  private lines: readonly string[] = DEFAULT_SEARCH_LINES;

  constructor(parent: HTMLElement, private readonly configs: ConfigService, bus?: EventBus<ConfigEvents>) {
    injectScreenStyle();
    injectStyle();
    this.root = document.createElement("div");
    this.root.className = "sa-screen sa-match-loading";
    this.root.style.display = "none";
    this.root.style.zIndex = "26";
    this.root.dataset["phase"] = "pending";
    const shade = document.createElement("div");
    shade.className = "sa-match-loading-shade";
    const panel = document.createElement("section");
    panel.className = "sa-match-loading-panel sa-panel sa-panel--holographic";
    this.kicker = document.createElement("div");
    this.kicker.className = "sa-match-loading-kicker";
    this.kicker.textContent = "PREPARING ARENA";
    this.title = document.createElement("h1");
    this.title.className = "sa-screen-title";
    this.elapsed = document.createElement("div");
    this.elapsed.className = "sa-match-loading-elapsed";
    // A count-UP: announced politely, never as a deadline.
    this.elapsed.setAttribute("role", "timer");
    this.elapsed.hidden = true;
    this.teams = document.createElement("div");
    this.teams.className = "sa-match-loading-teams";
    this.status = document.createElement("div");
    this.status.className = "sa-match-loading-status";
    this.status.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.setAttribute("aria-hidden", "true");
    this.statusText = document.createElement("span");
    this.statusText.className = "sa-match-loading-status-text";
    this.statusText.textContent = "Loading combat systems";
    this.status.append(spinner, this.statusText);
    this.progress = document.createElement("div");
    this.progress.className = "sa-match-loading-progress";
    this.progress.hidden = true;
    this.progressLabel = document.createElement("div");
    this.progressLabel.className = "sa-match-loading-progress-label";
    const track = document.createElement("div");
    track.className = "sa-progress";
    this.progressBar = document.createElement("div");
    this.progressBar.className = "sa-progress__bar";
    track.append(this.progressBar);
    this.progress.append(this.progressLabel, track);
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.className = "sa-screen-btn sa-button sa-button--secondary sa-match-loading-cancel";
    this.cancelButton.dataset["matchLoadingAction"] = "cancel";
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.hidden = true;
    this.cancelButton.addEventListener("click", () => this.onCancel?.());
    panel.append(
      this.kicker,
      this.title,
      this.elapsed,
      this.teams,
      this.status,
      this.progress,
      this.cancelButton,
    );
    this.root.append(shade, panel);
    parent.append(this.root);
    this.applyTheme();
    this.unsubscribe = bus?.on("config:changed", (event) => {
      if (event.type === "theme") this.applyTheme();
    }) ?? null;
  }

  get phase(): MatchLoadingPhase {
    return this.phaseValue;
  }

  /** Bare "something is happening" card: tutorial build, editor playtest, joins. */
  showPending(label = "Connecting to arena"): void {
    this.setPhase("pending");
    this.kicker.textContent = "PREPARING ARENA";
    this.title.textContent = label;
    this.statusText.textContent = "Loading combat systems";
    this.setRoster([], 0);
    this.root.style.removeProperty("--sa-loading-art");
    this.root.style.display = "flex";
  }

  /**
   * FIRST phase of an online launch: looking for pilots. Starts the count-up,
   * paints empty slots for both teams, and leaves the asset progress row to
   * {@link setAssetProgress} — the map is loading behind this card, not after it.
   */
  showSearching(options: MatchSearchOptions, now = Date.now()): void {
    this.setPhase("searching");
    this.kicker.textContent = "FINDING PLAYERS";
    if (options.title) this.title.textContent = options.title;
    if (options.art) this.root.style.setProperty("--sa-loading-art", options.art);
    else this.root.style.removeProperty("--sa-loading-art");
    this.onCancel = options.onCancel ?? null;
    this.cancelButton.hidden = this.onCancel === null;
    this.teamSize = Math.max(0, options.teamSize);
    this.rosterKey = "";
    this.setRoster([], this.teamSize);
    this.searchStartedAt = now;
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => this.tickElapsed(), ELAPSED_TICK_MS);
    this.tickElapsed(now);
    this.root.style.display = "flex";
  }

  /** Replace the roster columns (cheap no-op when nothing actually changed). */
  setRoster(roster: readonly LoadingRosterEntry[], teamSize = this.teamSize): void {
    this.teamSize = Math.max(0, teamSize);
    const key = `${this.teamSize}|${roster.map((e) => `${e.team}:${e.kind ?? "player"}:${e.name}`).join(",")}`;
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    renderRoster(this.teams, roster, this.teamSize);
  }

  /**
   * Background preload progress. Shown while the search is still running (so a
   * player who is found early knows what is left) and while the resolved card
   * waits on the last models; hidden once everything is in memory.
   */
  setAssetProgress(loaded: number, total: number): void {
    if (total <= 0 || loaded >= total) {
      this.progress.hidden = true;
      this.progressLabel.textContent = "";
      this.progressBar.style.removeProperty("--sa-progress");
      if (this.phaseValue === "searching") this.statusText.textContent = this.searchFlavor();
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
    this.progress.hidden = false;
    this.progressLabel.textContent = `Loading arena assets — ${pct}%`;
    this.progressBar.style.setProperty("--sa-progress", `${pct}%`);
  }

  /**
   * The pilots are in: settle onto the resolved arena card (art, name, final
   * roster) and start the theme's minimum-visible hold.
   */
  showSession(session: GameSession, contentBase: string, snapshot?: Snapshot): void {
    const arena = this.configs.get<ArenaConfig>("arena", session.arenaId);
    this.setPhase("ready");
    this.kicker.textContent = "PREPARING ARENA";
    this.title.textContent = arena?.name ?? session.arenaId;
    if (arena?.render?.skybox.texture) {
      this.root.style.setProperty("--sa-loading-art", `url("${contentBase}content/${arena.render.skybox.texture}")`);
    }
    this.statusText.textContent = "Loading combat systems";
    this.rosterKey = "";
    this.setRoster(loadingRoster(session, snapshot ?? session.rosterSnapshot));
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

  hide(): void {
    this.shownAtMs = null;
    this.stopElapsedTimer();
    this.onCancel = null;
    this.cancelButton.hidden = true;
    this.root.style.display = "none";
  }

  dispose(): void {
    this.stopElapsedTimer();
    this.unsubscribe?.();
    this.root.remove();
  }

  /** Advance the count-up. Exposed for tests; the interval calls it 4x/second. */
  tickElapsed(now = Date.now()): void {
    if (this.phaseValue !== "searching") return;
    this.elapsed.textContent = formatCountUp(now - this.searchStartedAt);
  }

  private setPhase(phase: MatchLoadingPhase): void {
    this.phaseValue = phase;
    this.root.dataset["phase"] = phase;
    this.elapsed.hidden = phase !== "searching";
    if (phase !== "searching") {
      this.stopElapsedTimer();
      this.cancelButton.hidden = true;
      this.onCancel = null;
    } else {
      this.statusText.textContent = this.searchFlavor();
    }
  }

  private searchFlavor(): string {
    return this.lines[0] ?? DEFAULT_SEARCH_LINES[0];
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }

  private applyTheme(): void {
    const theme = this.configs.get<ThemeConfig>("theme", "theme.default");
    applyMenuTheme(this.root, theme);
    const authored = theme?.menu?.matchmaking?.flavorLines;
    this.lines = authored?.length ? authored : DEFAULT_SEARCH_LINES;
    if (this.phaseValue === "searching" && this.progress.hidden) {
      this.statusText.textContent = this.searchFlavor();
    }
  }
}

/**
 * Draw the team columns. Every seated pilot is a row; every slot the room is
 * still trying to fill is a muted placeholder row, so a phone-sized card never
 * changes height as the roster arrives.
 */
export function renderRoster(
  host: HTMLElement,
  roster: readonly LoadingRosterEntry[],
  teamSize = 0,
): void {
  host.replaceChildren();
  for (const { team, filled, empty } of rosterTeams(roster, teamSize)) {
    const group = document.createElement("section");
    group.className = "sa-match-loading-team sa-panel sa-panel--top-accent";
    group.dataset["team"] = String(team);
    const heading = document.createElement("h2");
    heading.textContent = `TEAM ${team + 1}`;
    if (teamSize > 0) {
      const count = document.createElement("span");
      count.className = "sa-match-loading-count";
      count.textContent = `${filled.length}/${teamSize}`;
      heading.append(count);
    }
    group.append(heading);
    for (const entry of filled) {
      const pilot = document.createElement("div");
      pilot.className = "sa-match-loading-pilot";
      pilot.dataset["kind"] = entry.kind ?? "player";
      pilot.textContent = entry.name;
      if (entry.kind === "bot") {
        const tag = document.createElement("span");
        tag.className = "sa-match-loading-tag";
        tag.textContent = "BOT";
        pilot.append(tag);
      }
      group.append(pilot);
    }
    for (let i = 0; i < empty; i++) {
      const slot = document.createElement("div");
      slot.className = "sa-match-loading-pilot";
      slot.dataset["kind"] = "empty";
      slot.textContent = "· · ·";
      group.append(slot);
    }
    host.append(group);
  }
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/*
 * Phone-first: every dimension is relative (clamp/min/vw/vh), the card is a
 * single flex column, and the SCREEN scrolls rather than any inner box — so a
 * 10v10 roster on a 360px handset never clips and never forces sideways scroll.
 * Both blurred layers are position:fixed (never negatively inset), which is what
 * keeps the scroll container free of overflow.
 */
.sa-match-loading{isolation:isolate;background:var(--sa-n-900);overflow-x:hidden;overflow-y:auto;
  padding:calc(env(safe-area-inset-top,0px) + clamp(12px,3vh,44px))
          calc(env(safe-area-inset-right,0px) + clamp(12px,4vw,48px))
          calc(env(safe-area-inset-bottom,0px) + clamp(12px,3vh,44px))
          calc(env(safe-area-inset-left,0px) + clamp(12px,4vw,48px))}
.sa-match-loading::before{content:"";position:fixed;inset:0;background-image:var(--sa-loading-art);background-size:cover;background-position:center;filter:blur(12px);transform:scale(1.08);z-index:-2}
.sa-match-loading-shade{position:fixed;inset:0;background:linear-gradient(180deg,rgba(3,7,17,.54),rgba(3,7,17,.9) 72%,rgba(3,7,17,.98));z-index:-1}
/* .sa-screen centres its content with ::before/::after flex spacers. This card
   claims ::before for its blurred art, so the surviving ::after would absorb all
   the free space and pin the panel to the top of a tall phone; retire it and let
   the panel's own auto margins centre it (they collapse to 0 when it overflows,
   which is what keeps a 10v10 roster scrollable from the top). */
.sa-match-loading::after{display:none}
.sa-match-loading [hidden]{display:none}
.sa-match-loading-panel{display:flex;flex-direction:column;align-items:stretch;gap:clamp(10px,2.4vh,20px);
  width:min(920px,100%);max-width:100%;margin:auto;padding:clamp(14px,4vw,28px);text-align:center;box-sizing:border-box}
.sa-match-loading-kicker{color:var(--sa-menu-accent,var(--sa-white));font-size:clamp(.6rem,2.6vw,.72rem);letter-spacing:.28em;word-break:break-word}
.sa-match-loading .sa-screen-title{margin:0;font-size:clamp(17px,5.4vw,30px);overflow-wrap:anywhere}
.sa-match-loading-elapsed{color:var(--sa-menu-primary,var(--sa-blue-500));font:600 clamp(22px,8vw,38px)/1 ui-monospace,monospace;font-variant-numeric:tabular-nums;letter-spacing:.14em}
.sa-match-loading-teams{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:clamp(8px,2.5vw,24px);margin:0}
.sa-match-loading-teams:empty{display:none}
.sa-match-loading-team{min-width:0;padding:clamp(9px,2.6vw,20px);background:color-mix(in srgb,var(--sa-menu-panel,var(--sa-n-800)) 82%,transparent);border:1px solid color-mix(in srgb,var(--sa-menu-primary,var(--sa-blue-500)) 45%,transparent);clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}
.sa-match-loading-team h2{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:.6em;margin:0 0 clamp(6px,1.6vh,12px);color:var(--sa-menu-primary,var(--sa-blue-500));font-size:clamp(.58rem,2.4vw,.76rem);letter-spacing:.2em}
.sa-match-loading-count{color:var(--sa-menu-muted,var(--sa-n-400));font-variant-numeric:tabular-nums;letter-spacing:.08em}
.sa-match-loading-pilot{padding:clamp(4px,1.4vw,8px) 2px;min-height:1.5em;overflow-wrap:anywhere;color:var(--sa-menu-text,var(--sa-white));font-size:clamp(11px,3.2vw,15px);line-height:1.35}
.sa-match-loading-pilot[data-kind="you"]{color:var(--sa-menu-accent,var(--sa-white));font-weight:600}
.sa-match-loading-pilot[data-kind="empty"]{color:var(--sa-menu-muted,var(--sa-n-400));opacity:.5;letter-spacing:.24em}
.sa-match-loading-tag{margin-left:.5em;padding:1px 5px;font-size:.68em;letter-spacing:.14em;color:var(--sa-menu-muted,var(--sa-n-400));border:1px solid color-mix(in srgb,var(--sa-menu-muted,var(--sa-n-400)) 55%,transparent);white-space:nowrap}
.sa-match-loading-status{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;color:var(--sa-menu-muted,var(--sa-n-400));font-size:clamp(.68rem,2.8vw,.8rem);letter-spacing:.1em}
.sa-match-loading-status > span:first-child{flex:0 0 auto;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sa-loading-spin .8s linear infinite}
.sa-match-loading-progress{display:flex;flex-direction:column;gap:6px;width:min(420px,100%);margin:0 auto}
.sa-match-loading-progress-label{color:var(--sa-menu-muted,var(--sa-n-400));font-size:clamp(.62rem,2.6vw,.74rem);letter-spacing:.1em;font-variant-numeric:tabular-nums}
.sa-match-loading-cancel{width:min(240px,100%);margin:0 auto}
@keyframes sa-loading-spin{to{transform:rotate(360deg)}}
/* Landscape handsets: vertical room is the scarce axis, so trade type size and
   padding for rows rather than pushing the roster off the card. */
@media (orientation:landscape) and (max-height:520px){
  .sa-match-loading{padding-top:calc(env(safe-area-inset-top,0px) + 10px);padding-bottom:calc(env(safe-area-inset-bottom,0px) + 10px)}
  .sa-match-loading-panel{gap:clamp(6px,1.6vh,12px);padding:clamp(10px,2.4vw,18px)}
  .sa-match-loading .sa-screen-title{font-size:clamp(15px,4.2vh,24px)}
  .sa-match-loading-elapsed{font-size:clamp(18px,5vh,28px)}
  .sa-match-loading-pilot{padding:2px;font-size:clamp(10px,2.4vh,13px);min-height:1.3em}
  .sa-match-loading-cancel{min-height:40px}
}
@media (prefers-reduced-motion:reduce){
  .sa-match-loading-status > span:first-child{animation:none}
}
`;
  document.head.append(style);
}
