/**
 * Environment configuration — the single source of truth (ROADMAP §11 6.3).
 *
 * Every tunable the server reads from the process environment is declared here,
 * parsed once, validated once, and exposed as a frozen {@link ServerEnv}. Nothing
 * else in the codebase should reach for `process.env` for these values.
 *
 * Failure model: {@link parseEnv} is pure and collects *all* problems rather than
 * throwing on the first, so a misconfigured deploy prints one complete list
 * instead of a game of whack-a-mole across restarts. {@link getEnv} memoizes it
 * and throws {@link EnvError} the first time anything asks for a bad config —
 * `index.ts` asks before it opens a socket, so production fails fast at boot.
 *
 * Strictness is tied to `NODE_ENV=production`:
 *
 * | var              | dev / test                          | production                                   |
 * |------------------|-------------------------------------|----------------------------------------------|
 * | `PORT`           | 2567                                | 2567 (must be an integer 1–65535)            |
 * | `SPACE_ARENA_DB` | `<cwd>/data/space-arena.db`         | same default; use a mounted volume path      |
 * | `CORS_ORIGIN`    | unset ⇒ any `*:5173` (LAN phones)   | unset ⇒ SAME-ORIGIN ONLY (+ warning); `*` is rejected |
 * | `JWT_SECRET`     | unset ⇒ insecure dev fallback       | REQUIRED, ≥ 32 chars, not a known placeholder |
 * | `CONTENT_DIR`    | repo `content/`                     | same default; override for a mounted pack    |
 * | `CLIENT_DIR`     | repo `client/dist`                  | same default; must exist when serving        |
 * | `SERVE_CLIENT`   | on iff `client/dist` exists         | same                                         |
 * | `SPACE_ARENA_TELEMETRY` | off ⇒ no `server_metrics` rows | on; opt out explicitly with `=0`          |
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Default listen port, matching the Vite dev proxy target and the Dockerfile. */
export const DEFAULT_PORT = 2567;

/** The dev-only JWT signing secret. Named here so the weak-secret check can reject it. */
export const DEV_JWT_SECRET = "dev-insecure-secret-change-me";

/** Minimum accepted length of a production `JWT_SECRET` (256 bits of hex/base64-ish). */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Obvious placeholders that must never sign a production token even if they are
 * long enough. Compared case-insensitively against the trimmed secret.
 */
const WEAK_JWT_SECRETS = new Set([
  DEV_JWT_SECRET,
  "secret",
  "changeme",
  "change-me",
  "change_me",
  "password",
  "jwt-secret",
  "jwtsecret",
  "test",
  "insecure",
  "space-arena",
]);

/** Repo root, resolved from this module (server/src/env.ts → ../../). */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface ServerEnv {
  /** Raw `NODE_ENV`, defaulted to "development". */
  readonly nodeEnv: string;
  /** True iff `NODE_ENV === "production"` — the switch every strict check reads. */
  readonly isProduction: boolean;
  /** TCP port for the HTTP + WebSocket server. */
  readonly port: number;
  /** Absolute (or `:memory:`) path to the SQLite database file. */
  readonly dbPath: string;
  /**
   * Explicit CORS allowlist from `CORS_ORIGIN`, or `null` to use the permissive
   * dev rule (any origin on port 5173). An empty array means "same-origin only".
   */
  readonly corsOrigins: readonly string[] | null;
  /** JWT signing secret. Always non-empty; the dev fallback outside production. */
  readonly jwtSecret: string;
  /** True when {@link jwtSecret} is the insecure dev fallback rather than a real one. */
  readonly jwtSecretIsDevFallback: boolean;
  /** Absolute path to the content pack directory served at `/content/*`. */
  readonly contentDir: string;
  /** Absolute path to the built client (`client/dist`), or null when not serving one. */
  readonly clientDir: string | null;
  /** Enable the Colyseus monitor + verbose room logging. */
  readonly devTools: boolean;
  /**
   * Persist periodic `server_metrics` rollups (ROADMAP §11 6.8). On in
   * production; off in dev unless `SPACE_ARENA_TELEMETRY=1`, so an ordinary
   * `npm run dev:server` session does not fill the working database with a row
   * every ten seconds. The in-memory metrics registry runs either way — this
   * gates only the database writes.
   */
  readonly telemetryEnabled: boolean;
}

/** Thrown by {@link getEnv} when the environment is not fit to boot. */
export class EnvError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`invalid environment configuration:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

export interface ParsedEnv {
  /** Parsed config. Present even when {@link errors} is non-empty (fields fall back to defaults). */
  env: ServerEnv;
  /** Fatal problems — the server must not boot. */
  errors: string[];
  /** Non-fatal problems worth logging at boot. */
  warnings: string[];
}

type EnvSource = Record<string, string | undefined>;

function str(source: EnvSource, key: string): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `"0"`/`"false"`/`"off"`/`"no"` ⇒ false, `"1"`/`"true"`/`"on"`/`"yes"` ⇒ true. */
function bool(source: EnvSource, key: string): boolean | undefined {
  const raw = str(source, key)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  return undefined;
}

/**
 * Parse + validate an environment. Pure: takes the source map, touches no
 * globals besides the filesystem existence checks, and returns every problem it
 * found rather than throwing.
 */
export function parseEnv(source: EnvSource = process.env): ParsedEnv {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodeEnv = str(source, "NODE_ENV") ?? "development";
  const isProduction = nodeEnv === "production";

  // --- PORT -----------------------------------------------------------------
  let port = DEFAULT_PORT;
  const rawPort = str(source, "PORT");
  if (rawPort !== undefined) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535 (got ${JSON.stringify(rawPort)})`);
    } else {
      port = parsed;
    }
  }

  // --- SPACE_ARENA_DB -------------------------------------------------------
  const rawDb = str(source, "SPACE_ARENA_DB");
  const dbPath =
    rawDb === undefined
      ? path.resolve(process.cwd(), "data", "space-arena.db")
      : rawDb === ":memory:"
        ? ":memory:"
        : path.resolve(rawDb);

  // --- CORS_ORIGIN ----------------------------------------------------------
  let corsOrigins: string[] | null = null;
  const rawCors = str(source, "CORS_ORIGIN");
  if (rawCors !== undefined) {
    const entries = rawCors
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (entries.length === 0) {
      errors.push("CORS_ORIGIN is set but lists no origins");
    }
    for (const entry of entries) {
      if (entry === "*") {
        if (isProduction) {
          errors.push('CORS_ORIGIN must not be "*" in production — list the real origins');
        } else {
          warnings.push('CORS_ORIGIN contains "*" — every origin may call the API');
        }
        continue;
      }
      // An origin is scheme://host[:port] and nothing else: no path, no trailing slash.
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        errors.push(`CORS_ORIGIN entry ${JSON.stringify(entry)} is not a valid origin (expected e.g. https://play.example.com)`);
        continue;
      }
      if (!/^https?:$/.test(url.protocol)) {
        errors.push(`CORS_ORIGIN entry ${JSON.stringify(entry)} must use http: or https:`);
      } else if (url.origin !== entry.replace(/\/$/, "")) {
        errors.push(`CORS_ORIGIN entry ${JSON.stringify(entry)} must be a bare origin — try ${JSON.stringify(url.origin)}`);
      }
      if (isProduction && url.protocol === "http:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
        warnings.push(`CORS_ORIGIN entry ${JSON.stringify(entry)} is plain http in production — tokens will travel unencrypted`);
      }
    }
    corsOrigins = entries.filter((e) => e !== "*");
    if (entries.includes("*") && !isProduction) corsOrigins = null; // dev wildcard ⇒ permissive rule
  } else if (isProduction) {
    // Single-container deploys (server serves client/dist) need no cross-origin
    // access at all, so the safe production default is "none" rather than "any".
    corsOrigins = [];
    warnings.push(
      "CORS_ORIGIN is not set — cross-origin browser requests are refused (same-origin only). " +
        "Set it if the client is hosted on a different origin than this server.",
    );
  }

  // --- JWT_SECRET -----------------------------------------------------------
  let jwtSecret = DEV_JWT_SECRET;
  let jwtSecretIsDevFallback = true;
  const rawSecret = str(source, "JWT_SECRET");
  if (rawSecret !== undefined) {
    jwtSecret = rawSecret;
    jwtSecretIsDevFallback = false;
    if (isProduction) {
      if (rawSecret.length < MIN_JWT_SECRET_LENGTH) {
        errors.push(
          `JWT_SECRET is too weak: ${rawSecret.length} characters, minimum ${MIN_JWT_SECRET_LENGTH} ` +
            "(generate one with `node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"`)",
        );
      }
      if (WEAK_JWT_SECRETS.has(rawSecret.toLowerCase())) {
        errors.push("JWT_SECRET is a known placeholder value — generate a random secret");
      } else if (new Set(rawSecret).size < 8) {
        errors.push(`JWT_SECRET has too little entropy (${new Set(rawSecret).size} distinct characters)`);
      }
    }
  } else if (isProduction) {
    errors.push("JWT_SECRET must be set in production");
  } else {
    warnings.push("JWT_SECRET not set — using the insecure dev fallback. Set JWT_SECRET in production.");
  }

  // --- CONTENT_DIR ----------------------------------------------------------
  const rawContent = str(source, "CONTENT_DIR");
  const contentDir = rawContent === undefined ? path.join(REPO_ROOT, "content") : path.resolve(rawContent);
  if (!existsSync(path.join(contentDir, "manifest.json"))) {
    errors.push(`CONTENT_DIR ${JSON.stringify(contentDir)} has no manifest.json — point CONTENT_DIR at the content pack`);
  }

  // --- CLIENT_DIR / SERVE_CLIENT -------------------------------------------
  const rawClient = str(source, "CLIENT_DIR");
  const candidateClientDir = rawClient === undefined ? path.join(REPO_ROOT, "client", "dist") : path.resolve(rawClient);
  const clientBuilt = existsSync(path.join(candidateClientDir, "index.html"));
  const serveClient = bool(source, "SERVE_CLIENT") ?? clientBuilt;
  let clientDir: string | null = null;
  if (serveClient) {
    if (clientBuilt) {
      clientDir = candidateClientDir;
    } else if (bool(source, "SERVE_CLIENT") === true) {
      // Explicitly asked for, but there is nothing to serve — that is a config bug.
      errors.push(`SERVE_CLIENT is on but ${JSON.stringify(path.join(candidateClientDir, "index.html"))} does not exist — run \`npm run build\``);
    }
  }
  if (isProduction && clientDir === null && bool(source, "SERVE_CLIENT") !== false) {
    warnings.push(
      `no built client at ${JSON.stringify(candidateClientDir)} — serving the API only. ` +
        "Run `npm run build` or set CLIENT_DIR.",
    );
  }

  const devTools = !isProduction || bool(source, "COLYSEUS_MONITOR") === true;
  const telemetryEnabled = bool(source, "SPACE_ARENA_TELEMETRY") ?? isProduction;

  const env: ServerEnv = Object.freeze({
    nodeEnv,
    isProduction,
    port,
    dbPath,
    corsOrigins: corsOrigins === null ? null : Object.freeze([...corsOrigins]),
    jwtSecret,
    jwtSecretIsDevFallback,
    contentDir,
    clientDir,
    devTools,
    telemetryEnabled,
  });

  return { env, errors, warnings };
}

let cached: ParsedEnv | null = null;

/**
 * The process-wide {@link ServerEnv}, parsed on first use and memoized.
 * Throws {@link EnvError} when the environment has fatal problems.
 */
export function getEnv(): ServerEnv {
  cached ??= parseEnv();
  if (cached.errors.length > 0) throw new EnvError(cached.errors);
  return cached.env;
}

/** Warnings collected while parsing (empty until {@link getEnv} has run at least once). */
export function envWarnings(): readonly string[] {
  cached ??= parseEnv();
  return cached.warnings;
}

/** A boot-log-safe view of the environment: secrets redacted, paths intact. */
export function describeEnv(env: ServerEnv): Record<string, unknown> {
  return {
    nodeEnv: env.nodeEnv,
    port: env.port,
    dbPath: env.dbPath,
    corsOrigins: env.corsOrigins === null ? "(dev: any *:5173)" : env.corsOrigins.length === 0 ? "(same-origin only)" : env.corsOrigins.join(","),
    jwtSecret: env.jwtSecretIsDevFallback ? "(insecure dev fallback)" : "(set)",
    contentDir: env.contentDir,
    clientDir: env.clientDir ?? "(not serving a client build)",
    devTools: env.devTools,
    telemetry: env.telemetryEnabled,
  };
}
