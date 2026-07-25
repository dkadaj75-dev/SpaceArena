import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, DEV_JWT_SECRET, MIN_JWT_SECRET_LENGTH, describeEnv, parseEnv } from "./env.js";

/**
 * Environment validation (ROADMAP §11 6.3).
 *
 * `parseEnv` is pure — it takes the source map — so every case here is a plain
 * function call with no `process.env` mutation and no ordering hazard.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTENT = path.join(REPO_ROOT, "content");

/** A strong-enough production secret (48 random-looking chars). */
const GOOD_SECRET = "Zk3p9Qv2Lr7XwB6yTn4Hs8Jd1Fg5Mc0AeUiOoPzRtYb";

/** Baseline production env with everything valid, so each test perturbs one thing. */
function prod(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { NODE_ENV: "production", JWT_SECRET: GOOD_SECRET, SERVE_CLIENT: "0", ...overrides };
}

describe("parseEnv — defaults", () => {
  it("boots with an empty environment and no fatal errors", () => {
    const { env, errors } = parseEnv({});
    expect(errors).toEqual([]);
    expect(env.isProduction).toBe(false);
    expect(env.port).toBe(DEFAULT_PORT);
    expect(env.contentDir).toBe(CONTENT);
    // null = the permissive dev CORS rule (any origin on :5173).
    expect(env.corsOrigins).toBeNull();
    expect(env.jwtSecret).toBe(DEV_JWT_SECRET);
    expect(env.jwtSecretIsDevFallback).toBe(true);
    expect(env.devTools).toBe(true);
  });

  it("warns (but does not fail) about the dev JWT fallback", () => {
    expect(parseEnv({}).warnings.join(" ")).toMatch(/JWT_SECRET not set/);
  });

  it("defaults the database under cwd/data and honours :memory:", () => {
    expect(parseEnv({}).env.dbPath).toBe(path.resolve(process.cwd(), "data", "space-arena.db"));
    expect(parseEnv({ SPACE_ARENA_DB: ":memory:" }).env.dbPath).toBe(":memory:");
    expect(parseEnv({ SPACE_ARENA_DB: "  ./tmp/x.db  " }).env.dbPath).toBe(path.resolve("./tmp/x.db"));
  });
});

describe("parseEnv — PORT", () => {
  it("accepts an integer in range", () => {
    expect(parseEnv({ PORT: "8080" }).env.port).toBe(8080);
  });

  it.each(["0", "70000", "-1", "abc", "2567.5"])("rejects %s", (value) => {
    const { errors, env } = parseEnv({ PORT: value });
    expect(errors.join(" ")).toMatch(/PORT must be an integer/);
    // The returned env still carries a usable default so callers can log it.
    expect(env.port).toBe(DEFAULT_PORT);
  });
});

describe("parseEnv — JWT_SECRET", () => {
  it("is required in production", () => {
    expect(parseEnv({ NODE_ENV: "production" }).errors.join(" ")).toMatch(/JWT_SECRET must be set in production/);
  });

  it("accepts a strong production secret", () => {
    const { env, errors } = parseEnv(prod());
    expect(errors).toEqual([]);
    expect(env.jwtSecret).toBe(GOOD_SECRET);
    expect(env.jwtSecretIsDevFallback).toBe(false);
  });

  it("rejects a short production secret", () => {
    const short = "a1B2c3D4e5F6g7";
    expect(short.length).toBeLessThan(MIN_JWT_SECRET_LENGTH);
    expect(parseEnv(prod({ JWT_SECRET: short })).errors.join(" ")).toMatch(/too weak/);
  });

  it("rejects the dev fallback as a known placeholder", () => {
    expect(parseEnv(prod({ JWT_SECRET: DEV_JWT_SECRET })).errors.join(" ")).toMatch(/known placeholder/);
  });

  it("rejects a long but low-entropy secret", () => {
    expect(parseEnv(prod({ JWT_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).errors.join(" ")).toMatch(/entropy/);
  });

  it("leaves a weak secret alone outside production", () => {
    expect(parseEnv({ JWT_SECRET: "short" }).errors).toEqual([]);
  });
});

describe("parseEnv — CORS_ORIGIN", () => {
  it("parses a comma list of bare origins", () => {
    const { env, errors } = parseEnv(prod({ CORS_ORIGIN: "https://play.example.com, https://cdn.example.com:8443" }));
    expect(errors).toEqual([]);
    expect(env.corsOrigins).toEqual(["https://play.example.com", "https://cdn.example.com:8443"]);
  });

  it("defaults production to same-origin only, with a warning", () => {
    const { env, errors, warnings } = parseEnv(prod());
    expect(errors).toEqual([]);
    expect(env.corsOrigins).toEqual([]);
    expect(warnings.join(" ")).toMatch(/CORS_ORIGIN is not set/);
  });

  it('rejects "*" in production', () => {
    expect(parseEnv(prod({ CORS_ORIGIN: "*" })).errors.join(" ")).toMatch(/must not be "\*" in production/);
  });

  it('allows "*" in dev as the permissive rule', () => {
    const { env, warnings } = parseEnv({ CORS_ORIGIN: "*" });
    expect(env.corsOrigins).toBeNull();
    expect(warnings.join(" ")).toMatch(/every origin/);
  });

  it("rejects entries with a path or a trailing slash", () => {
    expect(parseEnv(prod({ CORS_ORIGIN: "https://example.com/app" })).errors.join(" ")).toMatch(/must be a bare origin/);
    expect(parseEnv(prod({ CORS_ORIGIN: "not-a-url" })).errors.join(" ")).toMatch(/not a valid origin/);
    expect(parseEnv(prod({ CORS_ORIGIN: "ftp://example.com" })).errors.join(" ")).toMatch(/must use http: or https:/);
  });

  it("warns about plain http in production, but not for localhost", () => {
    expect(parseEnv(prod({ CORS_ORIGIN: "http://example.com" })).warnings.join(" ")).toMatch(/plain http in production/);
    expect(parseEnv(prod({ CORS_ORIGIN: "http://localhost:5173" })).warnings.join(" ")).not.toMatch(/plain http/);
  });
});

describe("parseEnv — CONTENT_DIR / CLIENT_DIR", () => {
  it("fails when CONTENT_DIR has no manifest.json", () => {
    expect(parseEnv({ CONTENT_DIR: path.join(REPO_ROOT, "server") }).errors.join(" ")).toMatch(/no manifest\.json/);
  });

  it("accepts an explicit CONTENT_DIR that does have one", () => {
    const { env, errors } = parseEnv({ CONTENT_DIR: CONTENT });
    expect(errors).toEqual([]);
    expect(env.contentDir).toBe(CONTENT);
  });

  it("serves no client when SERVE_CLIENT is off", () => {
    expect(parseEnv({ SERVE_CLIENT: "0" }).env.clientDir).toBeNull();
  });

  it("fails when SERVE_CLIENT is on but the build is missing", () => {
    const { errors } = parseEnv({ SERVE_CLIENT: "1", CLIENT_DIR: path.join(REPO_ROOT, "server") });
    expect(errors.join(" ")).toMatch(/SERVE_CLIENT is on but/);
  });
});

describe("describeEnv", () => {
  it("never leaks the signing secret", () => {
    const { env } = parseEnv(prod());
    const described = JSON.stringify(describeEnv(env));
    expect(described).not.toContain(GOOD_SECRET);
    expect(described).toContain("(set)");
  });

  it("marks the dev fallback explicitly", () => {
    expect(describeEnv(parseEnv({}).env).jwtSecret).toBe("(insecure dev fallback)");
  });
});
