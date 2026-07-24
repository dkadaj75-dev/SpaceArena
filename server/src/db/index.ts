import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";
import { createLogger } from "@space-arena/shared";

const log = createLogger("DB");

export type Db = Database.Database;

/** Directory holding the ordered `NNN-*.sql` migration files. */
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Resolve the DB file path from env (default ./data/space-arena.db). */
export function resolveDbPath(): string {
  const raw = process.env.SPACE_ARENA_DB;
  if (raw && raw.trim() !== "") return raw;
  return path.resolve(process.cwd(), "data", "space-arena.db");
}

/**
 * Open a better-sqlite3 connection at `dbPath` (":memory:" for tests), enable
 * WAL + foreign keys, and run any pending migrations. Synchronous by design —
 * better-sqlite3 is synchronous, which keeps the repos simple and race-free.
 */
export function openDatabase(dbPath = resolveDbPath()): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * Apply every `*.sql` file in migrations/ that has not yet been recorded, in
 * lexical (numbered) order, each inside a transaction, tracked in a `migrations`
 * table. Idempotent: safe to call at every boot.
 */
export function runMigrations(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db.prepare("SELECT name FROM migrations").all().map((r) => (r as { name: string }).name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  const record = db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      record.run(file, Date.now());
    });
    tx();
    count++;
    log.info("migration applied", { file });
  }
  if (count > 0) log.info("migrations complete", { applied: count });
}

// ---------------------------------------------------------------------------
// Process-wide singleton (mirrors configService's pattern).
// ---------------------------------------------------------------------------

let instance: Db | null = null;

export function setDb(db: Db): void {
  instance = db;
}

export function getDb(): Db {
  if (!instance) throw new Error("DB not initialized — call setDb(openDatabase()) at boot");
  return instance;
}

/** Run `fn` inside a synchronous better-sqlite3 transaction (all-or-nothing). */
export function withTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
