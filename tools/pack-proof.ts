/**
 * ROADMAP §11 6.7 / criterion S6 — end-to-end proof, repeatable.
 *
 *   npx tsx tools/pack-proof.ts
 *
 * Boots a **production-mode** server against a throwaway content directory and
 * database, then, without ever restarting that process, proves the whole
 * content-pack workflow:
 *
 *   1. a NEW arena (`arena.proof`) and a NEW module (`module.proof-lance`)
 *      do not exist — matchmaking refuses them;
 *   2. export the live pack over the admin API;
 *   3. add the arena + module to the exported bundle and import it;
 *   4. the same PID now serves them: `/api/admin/content/export` lists them,
 *      `/content/*` returns them, `/health` reports a new pack hash, and
 *      `POST /matchmake/create/arena` builds a real room on the new arena;
 *   5. roll back — everything reverts, still without a restart.
 *
 * Every assertion is printed with a PID and a wall clock, and the server's own
 * stdout is scanned to confirm exactly one boot happened. If the process had
 * restarted, the proof would be worthless — so it is checked, not assumed.
 *
 * Cleans up after itself: temp dirs removed, server killed, non-zero exit on any
 * failed assertion.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_CONTENT = path.join(REPO_ROOT, "content");
const CLIENT_DIST = path.join(REPO_ROOT, "client", "dist");

const ADMIN_EMAIL = "packproof@spacearena.local";
const ADMIN_PASSWORD = `proof-${randomBytes(9).toString("hex")}`;

/** New content the proof injects — deliberately distinguishable from anything shipped. */
const PROOF_ARENA_ID = "arena.proof";
const PROOF_ARENA_RADIUS = 137; // ring-nebula is 90; no shipped arena uses 137
const PROOF_MODULE_ID = "module.proof-lance";

let failures = 0;
let checks = 0;

function ok(label: string, detail = ""): void {
  checks++;
  console.log(`  \u001b[32mPASS\u001b[0m ${label}${detail ? `  ${detail}` : ""}`);
}

function fail(label: string, detail = ""): void {
  checks++;
  failures++;
  console.log(`  \u001b[31mFAIL\u001b[0m ${label}${detail ? `  ${detail}` : ""}`);
}

function check(condition: boolean, label: string, detail = ""): void {
  if (condition) ok(label, detail);
  else fail(label, detail);
}

function step(n: number, title: string): void {
  console.log(`\n\u001b[1m── ${n}. ${title}\u001b[0m`);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/** stdin is ignored, stdout/stderr are piped so the proof can inspect boot logs. */
type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

interface Server {
  child: ServerProcess;
  port: number;
  pid: number;
  output: () => string;
}

async function startServer(env: Record<string, string>, port: number): Promise<Server> {
  // cwd MUST be server/ — that is where `npm start -w server` runs from, and it
  // is how tsx finds server/tsconfig.json, whose `experimentalDecorators` the
  // Colyseus schema classes require. Booting from the repo root instead throws
  // inside @colyseus/schema's decorators.
  const child: ServerProcess = spawn(process.execPath, [require_tsx(), "src/index.ts"], {
    cwd: path.join(REPO_ROOT, "server"),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) buffer += `\n[server exited with code ${code}]\n`;
  });

  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${buffer}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not become healthy in 45s:\n${buffer}`);
    await sleep(250);
  }

  return { child, port, pid: child.pid!, output: () => buffer };
}

/** Path to the tsx CLI, which is how the Dockerfile runs the server too. */
function require_tsx(): string {
  return path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
}

async function run(command: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require_tsx(), ...command], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command.join(" ")} failed:\n${out}`))));
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class Api {
  constructor(
    private readonly base: string,
    private token = "",
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  async json<T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const res = await fetch(`${this.base}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  raw(route: string): Promise<Response> {
    return fetch(`${this.base}${route}`);
  }
}

/**
 * Ask Colyseus to CREATE a room (not join an existing one) with these options.
 * `create` rather than `joinOrCreate` is deliberate: it forces a fresh
 * `ArenaRoom.onCreate`, which is exactly where a room resolves its arena out of
 * the pack that is live at that instant.
 */
async function createRoom(
  api: Api,
  options: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string }> {
  const res = await api.json<Record<string, unknown>>("POST", "/matchmake/create/arena", options);
  const body = res.body;
  if (res.status >= 400 || body.error !== undefined) {
    return { ok: false, detail: String(body.error ?? body.message ?? res.status) };
  }
  const room = body.room as { roomId?: string; processId?: string } | undefined;
  return { ok: true, detail: `roomId=${room?.roomId ?? "?"}` };
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const workspace = await mkdtemp(path.join(tmpdir(), "sa-pack-proof-"));
  const contentDir = path.join(workspace, "content");
  const dbPath = path.join(workspace, "data", "proof.db");
  const port = 21000 + Math.floor(Math.random() * 4000);

  console.log("\u001b[1mOrion's Arm — content pack proof (ROADMAP §11 6.7 / S6)\u001b[0m");
  console.log(`workspace : ${workspace}`);
  console.log(`content   : ${contentDir} (copy of repo content/)`);
  console.log(`database  : ${dbPath}`);
  console.log(`port      : ${port}`);

  await cp(SOURCE_CONTENT, contentDir, { recursive: true });

  const serverEnv: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(port),
    CONTENT_DIR: contentDir,
    SPACE_ARENA_DB: dbPath,
    JWT_SECRET: randomBytes(32).toString("hex"),
    CLIENT_DIR: CLIENT_DIST,
    SPACE_ARENA_TELEMETRY: "0",
    LOG_LEVEL: "info",
  };

  let server: Server | null = null;
  try {
    step(0, "Prepare: admin account + production server");

    // The admin is created before the server opens the database, so the proof
    // never depends on the dev-login route (production does not mount it).
    await run(["tools/create-admin.ts", ADMIN_EMAIL, ADMIN_PASSWORD, "Pack Proof"], {
      SPACE_ARENA_DB: dbPath,
      CONTENT_DIR: contentDir,
      NODE_ENV: "development",
    });
    ok("admin account created in the temp database", `(${ADMIN_EMAIL})`);

    const clientBuilt = await fileExists(path.join(CLIENT_DIST, "index.html"));
    check(clientBuilt, "built client present at client/dist", clientBuilt ? "" : "run `npm run build` first");

    server = await startServer(serverEnv, port);
    const pid = server.pid;
    ok("production server listening", `NODE_ENV=production pid=${pid}`);

    const api = new Api(`http://127.0.0.1:${port}`);

    // --- 1. login -----------------------------------------------------------
    step(1, "Authenticate as admin");
    const login = await api.json<{ accessToken: string; profile: { userId: string } }>("POST", "/api/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    check(login.status === 200, "POST /api/auth/login → 200", `status=${login.status}`);
    api.setToken(login.body.accessToken);

    // A non-admin must not reach the endpoint — proves the gate is real, not decorative.
    const guest = await api.json<{ accessToken: string }>("POST", "/api/auth/guest", { displayName: "Nobody" });
    const guestApi = new Api(`http://127.0.0.1:${port}`, guest.body.accessToken);
    const guestExport = await guestApi.json("GET", "/api/admin/content/export");
    check(guestExport.status === 403, "non-admin GET /api/admin/content/export → 403", `status=${guestExport.status}`);
    const anonExport = await new Api(`http://127.0.0.1:${port}`).json("GET", "/api/admin/content/export");
    check(anonExport.status === 401, "anonymous GET /api/admin/content/export → 401", `status=${anonExport.status}`);

    // --- 2. baseline --------------------------------------------------------
    step(2, "Baseline: the new content does not exist yet");
    const baseHealth = await api.json<{ contentPack: { sourceHash: string; packVersion: number } }>("GET", "/health");
    const baseHash = baseHealth.body.contentPack.sourceHash;
    ok("GET /health reports the live pack", `v${baseHealth.body.contentPack.packVersion} ${baseHash.slice(0, 19)}…`);

    const before404 = await api.raw("/content/arenas/proof.json");
    check(before404.status === 404, "GET /content/arenas/proof.json → 404", `status=${before404.status}`);

    const beforeRoom = await createRoom(api, {
      gamemode: "gamemode.duel-1v1",
      arena: PROOF_ARENA_ID,
      token: login.body.accessToken,
    });
    check(!beforeRoom.ok, `matchmaking refuses ${PROOF_ARENA_ID}`, beforeRoom.detail);

    // --- 3. export ----------------------------------------------------------
    step(3, "Export the live pack");
    const exported = await api.json<Bundle>("GET", "/api/admin/content/export");
    check(exported.status === 200, "GET /api/admin/content/export → 200", `status=${exported.status}`);
    const bundle = exported.body;
    ok(
      "bundle received",
      `${bundle.packId} v${bundle.packVersion}, ${Object.keys(bundle.files).length} files, protocol ${bundle.protocolVersion}`,
    );
    check(bundle.sourceHash === baseHash, "export hash matches /health", bundle.sourceHash.slice(0, 19) + "…");
    check(
      exported.headers.get("content-disposition")?.includes(".pack.json") === true,
      "export is served as a downloadable attachment",
    );

    // --- 4. mutate ----------------------------------------------------------
    step(4, "Author: clone an arena and a module into the bundle");
    const mutated = mutateBundle(bundle);
    ok(`added ${PROOF_ARENA_ID}`, `bounds.radius ${PROOF_ARENA_RADIUS} (source arena.ring-nebula = 90)`);
    ok(`added ${PROOF_MODULE_ID}`, "cloned from module.laser-mk1");
    ok("manifest updated", `version ${bundle.packVersion} → ${mutated.packVersion}, ${Object.keys(mutated.files).length} files`);

    // A deliberately broken variant first: the gate must reject it, untouched.
    const brokenBundle = structuredClone(mutated) as Bundle;
    (brokenBundle.files[`arenas/${PROOF_ARENA_ID.split(".")[1]}.json`] as ArenaJson).asteroidPlacements = [
      { asteroidId: "asteroid.does-not-exist", position: { x: 0, z: 0 } },
    ];
    const rejected = await api.json<ImportErrorBody>("POST", "/api/admin/content/import", brokenBundle);
    check(rejected.status === 422, "a pack with a dangling reference → 422", `status=${rejected.status}`);
    check(
      rejected.body.errors?.some((e) => e.message.includes("dangling reference")) === true,
      "…and reports per-file errors in the editor's shape",
      JSON.stringify(rejected.body.errors?.[0] ?? {}).slice(0, 110),
    );
    const afterRejectHealth = await api.json<{ contentPack: { sourceHash: string } }>("GET", "/health");
    check(
      afterRejectHealth.body.contentPack.sourceHash === baseHash,
      "…and the live pack is byte-identical (nothing was written)",
    );

    const wrongProtocol = await api.json<ImportErrorBody>("POST", "/api/admin/content/import", {
      ...mutated,
      protocolVersion: mutated.protocolVersion + 1,
    });
    check(wrongProtocol.status === 422, "a protocolVersion mismatch → 422", `status=${wrongProtocol.status}`);

    // --- 5. import ----------------------------------------------------------
    step(5, "Import the new pack — no restart, no redeploy");
    const imported = await api.json<ImportOkBody>("POST", "/api/admin/content/import", mutated);
    check(imported.status === 200, "POST /api/admin/content/import → 200", `status=${imported.status}`);
    ok(
      "import result",
      `v${imported.body.packVersion}, ${imported.body.files} files, arenas=${imported.body.counts?.arena ?? "?"}, modules=${imported.body.counts?.module ?? "?"}`,
    );
    check(imported.body.rollbackAvailable === true, "previous pack retained for rollback");

    // --- 6. prove it is live ------------------------------------------------
    step(6, `Prove the new content is live in pid ${pid}`);
    const liveHealth = await api.json<{ contentPack: { sourceHash: string; packVersion: number } }>("GET", "/health");
    check(liveHealth.body.contentPack.sourceHash !== baseHash, "/health reports a NEW pack hash", `${liveHealth.body.contentPack.sourceHash.slice(0, 19)}…`);

    const reexport = await api.json<Bundle>("GET", "/api/admin/content/export");
    if (reexport.status !== 200) throw new Error(`re-export failed: ${reexport.status} ${JSON.stringify(reexport.body)}`);
    const reexported = Object.keys(reexport.body.files);
    check(reexported.includes("arenas/proof.json"), "a fresh export now contains arenas/proof.json", `${reexported.length} files`);
    check(reexported.includes("modules/proof-lance.json"), "…and modules/proof-lance.json");

    const servedArena = await api.raw("/content/arenas/proof.json");
    const servedJson = (await servedArena.json()) as ArenaJson;
    check(servedArena.status === 200, "GET /content/arenas/proof.json → 200 (what the browser fetches)");
    check(
      servedJson.bounds.radius === PROOF_ARENA_RADIUS,
      "…with the new bounds radius",
      `radius=${servedJson.bounds.radius}`,
    );
    check(
      servedArena.headers.get("cache-control") === "no-cache",
      "…served no-cache, so the SW's NetworkFirst rule always revalidates",
      `cache-control=${servedArena.headers.get("cache-control")}`,
    );

    const servedManifest = (await (await api.raw("/content/manifest.json")).json()) as { files: string[] };
    check(servedManifest.files.includes("arenas/proof.json"), "/content/manifest.json lists the new arena");

    const swSource = await readFile(path.join(CLIENT_DIST, "sw.js"), "utf8");
    check(
      /NetworkFirst/.test(swSource) && /content/.test(swSource),
      "service worker keeps /content/*.json NetworkFirst",
      "clients pick the pack up on their next load",
    );

    const afterRoom = await createRoom(api, {
      gamemode: "gamemode.duel-1v1",
      arena: PROOF_ARENA_ID,
      token: login.body.accessToken,
    });
    check(afterRoom.ok, `a NEW match can be created on ${PROOF_ARENA_ID}`, afterRoom.detail);

    const bogusRoom = await createRoom(api, {
      gamemode: "gamemode.duel-1v1",
      arena: "arena.still-does-not-exist",
      token: login.body.accessToken,
    });
    check(!bogusRoom.ok, "…while an unknown arena is still refused (the check is real)", bogusRoom.detail);

    // --- 7. rollback --------------------------------------------------------
    step(7, "Roll back to the previous pack");
    const rolled = await api.json<ImportOkBody>("POST", "/api/admin/content/rollback");
    check(rolled.status === 200, "POST /api/admin/content/rollback → 200", `status=${rolled.status}`);

    const rolledHealth = await api.json<{ contentPack: { sourceHash: string } }>("GET", "/health");
    check(rolledHealth.body.contentPack.sourceHash === baseHash, "/health hash is back to the original", `${baseHash.slice(0, 19)}…`);
    const gone = await api.raw("/content/arenas/proof.json");
    check(gone.status === 404, "GET /content/arenas/proof.json → 404 again", `status=${gone.status}`);
    const rolledRoom = await createRoom(api, {
      gamemode: "gamemode.duel-1v1",
      arena: PROOF_ARENA_ID,
      token: login.body.accessToken,
    });
    check(!rolledRoom.ok, `matchmaking refuses ${PROOF_ARENA_ID} once more`, rolledRoom.detail);

    // --- 8. same process? ---------------------------------------------------
    step(8, "Confirm nothing restarted");
    const output = server.output();
    const boots = output.split("\n").filter((l) => l.includes("listening on :")).length;
    check(boots === 1, "the server logged exactly one boot", `boots=${boots}`);
    check(server.child.exitCode === null, "the server process never exited", `pid=${pid} still alive`);
    const importLogs = output.split("\n").filter((l) => l.includes("content pack imported")).length;
    check(importLogs === 1, "one 'content pack imported' log line", `count=${importLogs}`);
  } finally {
    if (server) {
      server.child.kill("SIGTERM");
      await Promise.race([once(server.child), sleep(4000)]);
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n\u001b[1m${failures === 0 ? "\u001b[32mPACK PROOF PASSED" : "\u001b[31mPACK PROOF FAILED"}\u001b[0m — ` +
      `${checks - failures}/${checks} checks in ${seconds}s`,
  );
  if (failures > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Bundle mutation — the "authoring" half of the workflow, scripted
// ---------------------------------------------------------------------------

interface ArenaJson {
  id: string;
  name?: string;
  bounds: { shape: string; radius: number };
  asteroidPlacements: unknown[];
  [k: string]: unknown;
}

interface Bundle {
  kind: string;
  protocolVersion: number;
  packId: string;
  packVersion: number;
  generatedAt: string;
  sourceHash: string;
  manifest: { version: number; files: string[]; [k: string]: unknown };
  files: Record<string, unknown>;
}

interface ImportOkBody {
  ok: boolean;
  packVersion: number;
  files: number;
  counts?: Record<string, number>;
  rollbackAvailable: boolean;
}

interface ImportErrorBody {
  error: { code: string; message: string };
  stage?: string;
  errors?: { file: string; path: string; message: string }[];
}

/**
 * Clone `arena.ring-nebula` → `arena.proof` (different bounds radius) and
 * `module.laser-mk1` → `module.proof-lance`, then list both in the manifest and
 * bump the pack version. This is exactly what a designer would do in the Map and
 * Module editors, minus the mouse.
 *
 * `sourceHash` is intentionally NOT recomputed: the server never trusts it, and
 * leaving it stale demonstrates that validation — not a hash — is the gate.
 */
function mutateBundle(bundle: Bundle): Bundle {
  const next = structuredClone(bundle);

  const sourceArena = next.files["arenas/ring-nebula.json"] as ArenaJson | undefined;
  if (!sourceArena) throw new Error("expected arenas/ring-nebula.json in the exported pack");
  const proofArena: ArenaJson = {
    ...structuredClone(sourceArena),
    id: PROOF_ARENA_ID,
    name: "Proof Arena (imported without a redeploy)",
    bounds: { shape: "sphere", radius: PROOF_ARENA_RADIUS },
  };
  next.files["arenas/proof.json"] = proofArena;

  const sourceModule = next.files["modules/laser-mk1.json"] as Record<string, unknown> | undefined;
  if (!sourceModule) throw new Error("expected modules/laser-mk1.json in the exported pack");
  next.files["modules/proof-lance.json"] = {
    ...structuredClone(sourceModule),
    id: PROOF_MODULE_ID,
    name: "Proof Lance",
  };

  next.manifest = {
    ...next.manifest,
    version: next.manifest.version + 1,
    files: [...next.manifest.files, "arenas/proof.json", "modules/proof-lance.json"],
  };
  next.packVersion = next.manifest.version;
  next.generatedAt = new Date().toISOString();
  return next;
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(child: ServerProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("\n\u001b[31mpack-proof crashed:\u001b[0m", err);
  process.exit(1);
});
