/**
 * Telemetry query surface (ROADMAP §11 6.8) — "feeds balance & perf".
 *
 *   npm run telemetry:report
 *   npx tsx tools/telemetry-report.ts --days 30 --db ./data/space-arena.db
 *
 * Read-only. Four sections, one per question the roadmap asks of telemetry:
 *
 *   1. **Matches by mode** — what is actually being played, how long it lasts,
 *      and how often each team wins. A mode whose win rate sits at 80/20, or
 *      whose matches end in five seconds, is a balance bug with a number
 *      attached.
 *   2. **FPS bucket × device class** — the mobile performance criterion
 *      ("≥ 30 FPS on a mid-range phone") as a measurement rather than a hope.
 *   3. **Quality tier split** — whether the auto-tier picker is putting devices
 *      where it should, cross-referenced against the FPS they then got.
 *   4. **Server tick trend** — daily p95 of the simulation step against the
 *      33.3 ms budget, so a regression shows up as a trend and not as an
 *      incident.
 */
import path from "node:path";
import { FPS_BUCKETS, DEVICE_CLASSES, QUALITY_TIERS } from "@space-arena/shared";
import { openDatabase, setDb } from "../server/src/db/index.js";
import {
  clientMetricsRepo,
  matchResultsRepo,
  serverMetricsRepo,
  type ClientMetricRow,
  type MatchResultRow,
  type ServerMetricRow,
} from "../server/src/db/repos.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The roadmap's 30 Hz simulation step budget, for context on the tick trend. */
const TICK_BUDGET_MS = 1000 / 30;

interface Args {
  days: number;
  db: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else {
      const next = argv[i + 1];
      flags.set(arg.slice(2), next !== undefined && !next.startsWith("--") ? (i++, next) : "1");
    }
  }
  const days = Number(flags.get("days") ?? 7);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  return { days, db: flags.get("db") ?? null };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // `openDatabase()` falls back to SPACE_ARENA_DB / the default data/ path.
  const dbPath = args.db ? path.resolve(args.db) : undefined;
  setDb(openDatabase(dbPath));

  const since = Date.now() - args.days * DAY_MS;
  const matches = matchResultsRepo.since(since);
  const clients = clientMetricsRepo.since(since);
  const server = serverMetricsRepo.since(since);

  console.log(`\nSpace Arena telemetry — last ${args.days} day(s)`);
  console.log(`  database: ${dbPath ?? process.env["SPACE_ARENA_DB"] ?? "(default data/space-arena.db)"}`);
  console.log(`  window:   ${new Date(since).toISOString()} → now`);

  reportMatches(matches);
  reportClientFps(clients);
  reportQualityTiers(clients);
  reportTickTrend(server);
  console.log("");
}

// ---------------------------------------------------------------------------
// 1. Matches by mode
// ---------------------------------------------------------------------------

function reportMatches(rows: readonly MatchResultRow[]): void {
  section("MATCHES BY MODE");
  if (rows.length === 0) return void console.log("  (no matches recorded)");

  interface Agg {
    matches: number;
    durationS: number;
    team0: number;
    team1: number;
    draws: number;
    players: number;
    bots: number;
  }
  const byMode = new Map<string, Agg>();
  for (const row of rows) {
    const agg = byMode.get(row.mode) ?? { matches: 0, durationS: 0, team0: 0, team1: 0, draws: 0, players: 0, bots: 0 };
    agg.matches++;
    agg.durationS += row.duration_s;
    if (row.winner_team === 0) agg.team0++;
    else if (row.winner_team === 1) agg.team1++;
    else agg.draws++;
    agg.players += row.player_count;
    agg.bots += row.bot_count;
    byMode.set(row.mode, agg);
  }

  const table = [["mode", "matches", "avg dur", "win t0", "win t1", "draw", "avg players", "avg bots"]];
  for (const [mode, agg] of [...byMode].sort((a, b) => b[1].matches - a[1].matches)) {
    table.push([
      mode,
      String(agg.matches),
      `${(agg.durationS / agg.matches).toFixed(1)}s`,
      pct(agg.team0, agg.matches),
      pct(agg.team1, agg.matches),
      pct(agg.draws, agg.matches),
      (agg.players / agg.matches).toFixed(1),
      (agg.bots / agg.matches).toFixed(1),
    ]);
  }
  printTable(table);
  console.log(`\n  total: ${rows.length} match(es)`);
}

// ---------------------------------------------------------------------------
// 2. FPS bucket × device class
// ---------------------------------------------------------------------------

function reportClientFps(rows: readonly ClientMetricRow[]): void {
  section("CLIENT FPS BY DEVICE CLASS");
  if (rows.length === 0) return void console.log("  (no client reports)");

  const counts = new Map<string, number[]>();
  for (const row of rows) {
    const bucketIndex = FPS_BUCKETS.indexOf(row.fps_bucket as (typeof FPS_BUCKETS)[number]);
    if (bucketIndex < 0) continue; // a bucket this build does not know about
    const line = counts.get(row.device_class) ?? new Array<number>(FPS_BUCKETS.length).fill(0);
    line[bucketIndex]!++;
    counts.set(row.device_class, line);
  }

  const table = [["device", ...FPS_BUCKETS, "reports", "≥30 FPS"]];
  // Iterate the known classes first so an unexpected value still shows up, but
  // the common two always appear in a stable order.
  const classes = [...new Set([...DEVICE_CLASSES.filter((c) => counts.has(c)), ...counts.keys()])];
  for (const deviceClass of classes) {
    const line = counts.get(deviceClass)!;
    const total = line.reduce((a, b) => a + b, 0);
    // Buckets from index 2 ("30-45") up are at or above the mobile criterion.
    const atLeast30 = line.slice(2).reduce((a, b) => a + b, 0);
    table.push([deviceClass, ...line.map(String), String(total), pct(atLeast30, total)]);
  }
  printTable(table);
  console.log(`\n  total: ${rows.length} report(s) from ${new Set(rows.map((r) => r.session_hash)).size} session(s)`);
}

// ---------------------------------------------------------------------------
// 3. Quality tier split
// ---------------------------------------------------------------------------

function reportQualityTiers(rows: readonly ClientMetricRow[]): void {
  section("QUALITY TIER × DEVICE CLASS");
  if (rows.length === 0) return void console.log("  (no client reports)");

  const table = [["tier", ...DEVICE_CLASSES, "reports", "≥30 FPS"]];
  for (const tier of QUALITY_TIERS) {
    const forTier = rows.filter((r) => r.quality_tier === tier);
    if (forTier.length === 0) continue;
    const atLeast30 = forTier.filter((r) => FPS_BUCKETS.indexOf(r.fps_bucket as (typeof FPS_BUCKETS)[number]) >= 2).length;
    table.push([
      tier,
      ...DEVICE_CLASSES.map((c) => String(forTier.filter((r) => r.device_class === c).length)),
      String(forTier.length),
      pct(atLeast30, forTier.length),
    ]);
  }
  if (table.length === 1) return void console.log("  (no recognised tiers)");
  printTable(table);
}

// ---------------------------------------------------------------------------
// 4. Server tick trend
// ---------------------------------------------------------------------------

function reportTickTrend(rows: readonly ServerMetricRow[]): void {
  section("SERVER TICK TREND (p95 per day)");
  if (rows.length === 0) return void console.log("  (no server samples — is SPACE_ARENA_TELEMETRY on?)");

  interface DayAgg {
    samples: number;
    p95Sum: number;
    p95Max: number;
    roomsMax: number;
    ticks: number;
    rssMax: number;
  }
  const byDay = new Map<string, DayAgg>();
  for (const row of rows) {
    const day = new Date(row.sampled_at).toISOString().slice(0, 10);
    const agg = byDay.get(day) ?? { samples: 0, p95Sum: 0, p95Max: 0, roomsMax: 0, ticks: 0, rssMax: 0 };
    agg.samples++;
    agg.p95Sum += row.tick_p95_ms;
    agg.p95Max = Math.max(agg.p95Max, row.tick_p95_ms);
    agg.roomsMax = Math.max(agg.roomsMax, row.room_count);
    agg.ticks += row.tick_samples;
    agg.rssMax = Math.max(agg.rssMax, row.rss_bytes);
    byDay.set(day, agg);
  }

  const table = [["day", "samples", "mean p95", "worst p95", "% of budget", "peak rooms", "peak rss", "ticks"]];
  for (const [day, agg] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    const meanP95 = agg.p95Sum / agg.samples;
    table.push([
      day,
      String(agg.samples),
      `${meanP95.toFixed(3)}ms`,
      `${agg.p95Max.toFixed(3)}ms`,
      `${((agg.p95Max / TICK_BUDGET_MS) * 100).toFixed(1)}%`,
      String(agg.roomsMax),
      `${(agg.rssMax / (1024 * 1024)).toFixed(0)}MB`,
      String(agg.ticks),
    ]);
  }
  printTable(table);
  console.log(`\n  step budget: ${TICK_BUDGET_MS.toFixed(1)} ms (30 Hz)`);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function section(title: string): void {
  console.log(`\n${"─".repeat(78)}\n${title}\n${"─".repeat(78)}`);
}

function pct(part: number, total: number): string {
  return total === 0 ? "—" : `${((part / total) * 100).toFixed(0)}%`;
}

/** Print rows as a left-aligned column table; row 0 is the header. */
function printTable(rows: readonly string[][]): void {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  rows.forEach((row, index) => {
    const line = row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
    console.log(`  ${line.trimEnd()}`);
    if (index === 0) console.log(`  ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  });
}

try {
  main();
} catch (err) {
  console.error("\ntelemetry report failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
