import {
  ConfigService, bundleLoader, type AnyConfig, type BotprofileConfig,
  type ContentBundle, type CosmeticConfig, type ShipConfig, type ThemeConfig,
} from "@space-arena/shared";
import { defaultFitOf, fitMetrics, simulateEngagement, timeToKill } from "./balanceMath.js";

export interface PreviewContext { bundle: ContentBundle; config: AnyConfig; baseConfig?: AnyConfig }

export async function renderPreview(target: HTMLElement, context: PreviewContext): Promise<() => void> {
  target.replaceChildren(); target.className = "constellation-live-preview";
  const service = new ConfigService(bundleLoader(context.bundle));
  try { await service.load("manifest.json"); } catch { target.textContent = "Preview paused until the draft pack validates."; return () => {}; }
  switch (context.config.type) {
    case "theme": return themePreview(target, context.config as ThemeConfig);
    case "ship": case "module": case "upgrade": return balancePreview(target, service, context.config);
    case "cosmetic": return cosmeticPreview(target, context.config as CosmeticConfig);
    case "arena": case "asteroid": return arenaPreview(target, context.config);
    case "botprofile": return botPreview(target, context.config as BotprofileConfig);
    case "tuning": case "camera": return tuningPreview(target, service);
    case "progression": return progressionPreview(target, context.config);
    case "action": case "event": case "notification": case "effect": return chainPreview(target, context.config);
    default: target.append(note("Validated draft preview. Runtime application follows the policy above.")); return () => {};
  }
}

function themePreview(target: HTMLElement, theme: ThemeConfig): () => void {
  const previous = new Map<string, string>(); const root = document.documentElement;
  const vars: Record<string, string> = { ...theme.colors };
  const palette = theme.tokens?.palette;
  if (palette) for (const [key, value] of Object.entries(palette)) if (value) vars[`--sa-${camelToken(key)}`] = value;
  for (const [key, value] of Object.entries(vars)) { const cssKey = key.startsWith("--") ? key : `--${key}`; previous.set(cssKey, root.style.getPropertyValue(cssKey)); root.style.setProperty(cssKey, value); }
  const gallery = document.createElement("div"); gallery.className = "constellation-theme-gallery";
  gallery.innerHTML = '<div data-orientation="portrait"><b>PORTRAIT HUD</b><button type="button">PRIMARY</button><span>Shield 72%</span></div><div data-orientation="landscape"><b>LANDSCAPE HUD</b><button type="button">ACTION</button><span>Heat 31%</span></div>';
  target.append(note("Draft design tokens are published immediately into this shell; discard/exit restores them."), gallery);
  return () => { for (const [key, value] of previous) { if (value) root.style.setProperty(key, value); else root.style.removeProperty(key); } };
}

function balancePreview(target: HTMLElement, service: ConfigService, config: AnyConfig): () => void {
  const ships = service.getAll<ShipConfig>("ship"); const ship = config.type === "ship" ? config as ShipConfig : ships[0];
  if (!ship) { target.append(note("No ship is available for a fit preview.")); return () => {}; }
  const fit = defaultFitOf(ship); const metrics = fitMetrics(ship, service, fit); const stock = ships[0] ? fitMetrics(ships[0], service, defaultFitOf(ships[0])) : metrics;
  const sim = simulateEngagement(ship, service, fit, { duration: 6, dt: 0.1 });
  target.append(title("Hangar · balance identity"), chips([
    ["Hull", metrics.hull], ["Burst DPS", metrics.burstDps], ["Sustained DPS", metrics.sustainedDps],
    ["Burn", metrics.timeToOverheat], ["Cool", metrics.recoverSec], ["TTK stock", timeToKill(metrics, stock)],
  ]), note(`6 s simplified audit · uptime ${(sim.uptime * 100).toFixed(0)}% · ${sim.lockouts} lockouts. Deltas use balanceMath/resolveShipStats; movement and LoS are excluded.`));
  return () => {};
}

function cosmeticPreview(target: HTMLElement, cosmetic: CosmeticConfig): () => void {
  const hull = document.createElement("div"); hull.className = "constellation-painted-hull"; hull.style.setProperty("--paint-primary", cosmetic.paint.primary); hull.style.setProperty("--paint-accent", cosmetic.paint.accent); hull.setAttribute("aria-label", `Painted hull swatch ${cosmetic.paint.primary} and ${cosmetic.paint.accent}`);
  target.append(title("Painted item preview"), hull, note(`Applies to ${cosmetic.target}.`)); return () => {};
}

function arenaPreview(target: HTMLElement, config: AnyConfig): () => void {
  const data = config as unknown as { bounds?: unknown; spawns?: unknown[]; asteroids?: unknown[]; objectives?: unknown[] };
  target.dataset.sceneRebuild = config.id; target.append(title("EditorStage scene rebuild"), note(`Draft scene rebuilt for ${config.id}: ${data.spawns?.length ?? 0} spawns · ${data.asteroids?.length ?? 0} asteroids · ${data.objectives?.length ?? 0} objectives. Camera is preserved; no live match is mutated.`)); return () => { delete target.dataset.sceneRebuild; };
}

export function seededBotAudit(profile: BotprofileConfig, seed = 73): { winner: string; role: string; score: number; urgency: number; target: string } {
  const rows = Object.entries(profile.behaviors).map(([id, value]) => ({ id, score: value.baseWeight * (0.85 + (((seed + id.length * 17) % 31) / 100)) }));
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); const winner = rows[0] ?? { id: "idle", score: 0 };
  return { winner: winner.id, role: profile.fittingArchetype ?? "balanced", score: winner.score, urgency: Math.min(1, winner.score / Math.max(1, rows.reduce((n, r) => n + r.score, 0))), target: "fixture.enemy.nearest" };
}

function botPreview(target: HTMLElement, profile: BotprofileConfig): () => void { const started = performance.now(); const audit = seededBotAudit(profile); target.append(title("Seeded mini-audit · seed 73"), chips([["Winner", audit.winner], ["Role", audit.role], ["Score", audit.score], ["Urgency", audit.urgency], ["Target", audit.target]]), note(`Deterministic authoring fixture completed in ${(performance.now() - started).toFixed(1)} ms; this is a decision audit, not a match simulation.`)); return () => {}; }
function tuningPreview(target: HTMLElement, service: ConfigService): () => void { const started = performance.now(); const ships = service.getAll<ShipConfig>("ship"); for (const ship of ships) simulateEngagement(ship, service, defaultFitOf(ship), { duration: 6, dt: 0.1 }); target.append(title("Balance identities · draft pack"), note(`${ships.length} stock fits audited for 6 simulated seconds in ${(performance.now() - started).toFixed(1)} ms. Formula source: balanceMath → resolveShipStats. Results are simplified (no movement/LoS).`)); return () => {}; }
function progressionPreview(target: HTMLElement, config: AnyConfig): () => void { const p = config as unknown as { xpCurve?: number[]; unlocks?: Record<string, string[]> }; let cumulative = 0; const rows = (p.xpCurve ?? []).map((xp, i) => `L${i + 1}: ${(cumulative += xp)} XP`); target.append(title("Progression curve"), note(rows.join(" · ") || "No levels"), note(`${Object.keys(p.unlocks ?? {}).length} authored unlock levels.`)); return () => {}; }
function chainPreview(target: HTMLElement, config: AnyConfig): () => void { const data = config as unknown as { kind?: string; trigger?: string; actions?: string[]; params?: unknown }; target.append(title("Sandbox chain"), note(`${data.trigger ?? data.kind ?? config.type} → ${(data.actions ?? []).join(" → ") || "isolated preview"}`), data.params ? note(`Params: ${JSON.stringify(data.params)}`) : document.createTextNode("")); return () => {}; }
function title(text: string): HTMLElement { const h = document.createElement("h3"); h.textContent = text; return h; }
function note(text: string): HTMLElement { const p = document.createElement("p"); p.className = "ed-note"; p.textContent = text; return p; }
function chips(values: [string, string | number][]): HTMLElement { const row = document.createElement("div"); row.className = "constellation-metric-chips"; for (const [label, value] of values) { const chip = document.createElement("span"); chip.innerHTML = `<b>${label}</b> ${typeof value === "number" ? (isFinite(value) ? value.toFixed(1) : "∞") : value}`; row.append(chip); } return row; }
function camelToken(key: string): string { return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`); }
