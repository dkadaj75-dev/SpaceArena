/**
 * Folds a directory of match-tracker records into aggregate balance numbers.
 *
 *   npx tsx tools/balance-report.ts .balance/ctf .balance/5v5
 *
 * Prints a markdown-ready digest; docs/Balancing.md is written from it.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MatchRecord } from "./match-tracker.js";

function load(dir: string): MatchRecord[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as MatchRecord);
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const f1 = (n: number): string => n.toFixed(1);

function shipName(id: string): string {
  return id.replace("ship.", "");
}

export function digest(label: string, matches: MatchRecord[]): string {
  const out: string[] = [];
  const pilots = matches.flatMap((m) => m.pilots);
  const byShip = new Map<string, typeof pilots>();
  for (const p of pilots) {
    const list = byShip.get(p.shipId) ?? [];
    list.push(p);
    byShip.set(p.shipId, list);
  }

  out.push(`### ${label}`);
  out.push("");
  out.push(`Matches: ${matches.length} · median length ${f1(median(matches.map((m) => m.durationSec)))}s · ` +
    `reached their win condition: ${matches.filter((m) => m.endedNaturally).length}/${matches.length}`);
  out.push("");

  // --- per hull -----------------------------------------------------------
  out.push("**Per hull**");
  out.push("");
  out.push("| hull | pilots | K | D | A | K/D | dmg dealt/min | dmg taken/min | share of all damage |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  const totalDealt = sum(pilots.map((p) => sum(Object.values(p.hullDamageByModule)) + sum(Object.values(p.shieldDamageByModule))));
  for (const [ship, list] of [...byShip.entries()].sort()) {
    const k = sum(list.map((p) => p.kills));
    const d = sum(list.map((p) => p.deaths));
    const a = sum(list.map((p) => p.assists));
    const dealt = sum(list.map((p) => sum(Object.values(p.hullDamageByModule)) + sum(Object.values(p.shieldDamageByModule))));
    const taken = sum(list.map((p) => p.hullDamageTaken + p.shieldDamageTaken));
    const mins = sum(list.map((p) => p.aliveSec)) / 60;
    out.push(`| ${shipName(ship)} | ${list.length} | ${k} | ${d} | ${a} | ${d ? (k / d).toFixed(2) : "∞"} | ` +
      `${f1(dealt / Math.max(1, mins))} | ${f1(taken / Math.max(1, mins))} | ${pct(dealt, totalDealt)} |`);
  }
  out.push("");

  // --- damage type --------------------------------------------------------
  const typeHull = new Map<string, number>();
  const typeShield = new Map<string, number>();
  for (const p of pilots) {
    for (const [t, v] of Object.entries(p.hullDamageByType)) typeHull.set(t, (typeHull.get(t) ?? 0) + v);
    for (const [t, v] of Object.entries(p.shieldDamageByType)) typeShield.set(t, (typeShield.get(t) ?? 0) + v);
  }
  const allTypes = [...new Set([...typeHull.keys(), ...typeShield.keys()])].sort();
  const grand = sum([...typeHull.values()]) + sum([...typeShield.values()]);
  out.push("**Per damage type** (energy = lasers/beams, kinetic = autocannons, hybrid = missiles)");
  out.push("");
  out.push("| type | to hull | to shields | total | share | % of its output wasted on shields |");
  out.push("|---|---:|---:|---:|---:|---:|");
  for (const t of allTypes) {
    const h = typeHull.get(t) ?? 0;
    const s = typeShield.get(t) ?? 0;
    out.push(`| ${t} | ${f1(h)} | ${f1(s)} | ${f1(h + s)} | ${pct(h + s, grand)} | ${pct(s, h + s)} |`);
  }
  out.push("");

  // --- time to kill -------------------------------------------------------
  const ttk = matches.flatMap((m) => m.ttkSamples);
  out.push("**Time to kill** (first damage taken → death, seconds)");
  out.push("");
  out.push(`Samples: ${ttk.length} · median ${f1(median(ttk.map((t) => t.sec)))}s · mean ${f1(mean(ttk.map((t) => t.sec)))}s`);
  out.push("");
  out.push("| killer → victim | n | median TTK |");
  out.push("|---|---:|---:|");
  const pairs = new Map<string, number[]>();
  for (const t of ttk) {
    const key = `${shipName(t.killerShip)} → ${shipName(t.victimShip)}`;
    (pairs.get(key) ?? pairs.set(key, []).get(key)!).push(t.sec);
  }
  for (const [key, xs] of [...pairs.entries()].sort((a, b) => median(a[1]) - median(b[1]))) {
    out.push(`| ${key} | ${xs.length} | ${f1(median(xs))} |`);
  }
  out.push("");

  // --- objective ----------------------------------------------------------
  const caps = sum(pilots.map((p) => p.flagsCaptured));
  const takes = sum(pilots.map((p) => p.flagsTaken));
  const drops = sum(pilots.map((p) => p.flagsDropped));
  if (takes > 0) {
    out.push("**Objective**");
    out.push("");
    out.push(`Flags taken ${takes} · captured ${caps} · dropped ${drops} · ` +
      `conversion ${pct(caps, takes)} · captures per match ${(caps / matches.length).toFixed(2)}`);
    out.push("");
  }

  // --- match shape --------------------------------------------------------
  const kills = matches.map((m) => sum(m.pilots.map((p) => p.kills)));
  const deathsPerPilot = mean(pilots.map((p) => p.deaths));
  out.push("**Match shape**");
  out.push("");
  out.push(`Kills per match: median ${f1(median(kills))} · deaths per pilot per match: ${f1(deathsPerPilot)} · ` +
    `a pilot dies about every ${f1(mean(matches.map((m) => m.durationSec)) / Math.max(1, deathsPerPilot))}s`);
  out.push("");
  return out.join("\n");
}

function main(): void {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const dir of dirs) {
    const matches = load(dir);
    process.stdout.write(digest(path.basename(dir), matches) + "\n");
  }
}

if (process.argv[1]?.includes("balance-report")) main();
