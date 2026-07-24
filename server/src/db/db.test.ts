import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "./index.js";

describe("migrations", () => {
  it("applies all migrations on a fresh in-memory DB and records them", () => {
    const db = openDatabase(":memory:");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => (r as { name: string }).name),
    );
    for (const t of ["users", "profiles", "ship_upgrades", "owned_modules", "fittings", "user_configs", "match_results", "sessions", "migrations"]) {
      expect(tables.has(t)).toBe(true);
    }
    const applied = db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
    expect(applied.n).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — a second run applies nothing new", () => {
    const db = openDatabase(":memory:") as Db;
    const first = (db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    runMigrations(db);
    const second = (db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    expect(second).toBe(first);
  });
});
