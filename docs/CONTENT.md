# Content packs — authoring, export, import, rollback

> ROADMAP §11 6.7 — success criterion **S6: "Exported content pack loads on a
> fresh server."** This document is the workflow that criterion describes, plus
> an honest account of what it does and does not do to a running match.

A **content pack** is the entire game as data: arenas, ships, modules,
gamemodes, bot profiles, upgrades, effects, themes, tuning. The server holds
exactly one live pack, in the directory `CONTENT_DIR` points at. That directory
is what `express.static` serves at `/content/*`, what `ConfigService` loads at
boot, and what every room reads its rules from.

> **Shipped asteroid presentation (2026-07-30):** low, medium, and high all
> retain authored asteroid GLBs for every visible LOD. Procedural recipes remain
> mandatory as the missing/corrupt-model fallback, not as the normal low-tier
> presentation. Arena assets are awaited before entity views are constructed.

The shipped pack contains two arenas, both fully supported — add either to a
gamemode's `defaultArena`, or pass `arena` as a join option:

| Arena | Radius | Used by | Notes |
| --- | --- | --- | --- |
| `arena.deep-field` | 300 | `gamemode.duel-1v1` | The flight-model arena (FLIGHT.md §6): belts and clusters with open lanes, spawns ~198 units apart. 300 is deliberately inside the ±320 position-quantization guard rail — **do not author an arena, spawn or asteroid past it** without a wire-format change. |
| `arena.ring-nebula` | 90 | `gamemode.practice-bots` | The original close-quarters arena. Still valid and still exercised. |

A new arena needs BOTH its `content/arenas/*.json` file and an entry in
`content/manifest.json` — a file the manifest does not list is silently not
loaded, and the first symptom is a gamemode falling back to a different arena.

> **Module and hardpoint expansion (2026-08-04):** the shipped catalogue now
> contains 40 modules. New weapon choices are the Burst Pulse Laser,
> Long-Barrel Cannon, Heavy Seeker Rack, and Sustained Beam Mk II; shields add
> Fortress Mk III and the quick, light Skirmish Deflector. The systems catalogue
> adds Armor Plating, a Flux Capacitor Bank, High-Output Dynamo, Precision Array,
> Endurance Drive, and Racing Overdrive. The heavy Brawler now carries six
> external hardpoints plus six internal slots, Support carries four external
> plus six internal slots, and the light Interceptor carries three external plus
> five internal slots. Socket transforms remain in ship-local coordinates and
> every `defaultFitting` stays positional over `hardpointsOf(ship)`.

> **Catalogue ladder and combat balance amendment (2026-08-04):** every
> functional module line now has an explicit Mk progression. Baseline systems
> use canonical Mk I–III ladders; named variants remain sidegrades and are not
> silently rebranded, while generator and utility sidegrades receive explicit
> Mk II successors. Relative to the preceding shipped catalogue, every weapon's
> per-shot damage (or continuous-beam DPS) is **1.6×**, every authored source of
> generated heat (`heat.perSecondActive`, `fire.heatPerShot`, and
> `boost.heatPerSec`) is **3×**, and shield/boost `energy.drawIdle` plus
> `energy.drawActive` are **2×**. Fire cadence and heatsink dissipation are
> unchanged. These are catalogue-wide owner balance constants, not hull tuning.

> **Weapon damage rebase (2026-08-05):** every weapon's authored `fire.damage`
> is **50%** of its prior value, rounded to 0.5-point steps. This includes
> continuous beams, for which `fire.damage` is DPS. Fire cadence, heat, and
> energy costs are unchanged.

> **Heat/energy overhaul (2026-08-07) — supersedes both notes above for every
> heat and energy number.** There is no ship heat pool and no shared capacitor.
> Each weapon authors its own `heat` block (`capacity`, `coolingPerSec`,
> `perShot` or `perSecondActive`, `rearmBelow`) and each energy-bearing module
> its own `energy` block (`capacity`, `rechargePerSec`, `drawPerSec`,
> `rearmAbove`); heatsinks author `cooling.multiplier` and generators
> `recharge.multiplier`, both ship-wide and multiplicative. **Weapons cost no
> energy at all.** Two identities do all the authoring work:
>
> ```
> burn (s)     = (capacity - perShot) / (generation - cooling)
> recovery (s) = capacity / cooling            duty = cooling / generation
> ```
>
> so a rack's damage across a whole trigger-down is `nominalDPS × cooling ÷
> generation`, independent of its capacity. The shipped catalogue is authored
> against the free kit (radiator ×1.6, plant ×1.25): mk1 weapons burn ~5 s and
> cool in ~2.5 s, mk2 ~6 s, mk3 ~7 s. Reproduce every number with
> `node --import tsx tools/heat-feel-bench.ts`.

A **bundle** is that pack serialized as one JSON document. It is the unit that
travels between machines:

```jsonc
{
  "kind": "space-arena.content-pack",
  "protocolVersion": 1,              // must match the target server
  "packId": "manifest.default",
  "packVersion": 1,                  // manifest.version
  "generatedAt": "2026-07-25T00:31:12.918Z",
  "sourceHash": "sha256:e8accfcd…",  // provenance digest over the contents
  "manifest": { "id": "manifest.default", "type": "manifest", "files": [ … ] },
  "files": {
    "arenas/ring-nebula.json": { … },
    "modules/laser-mk1.json":  { … }
  }
}
```

The whole loop is: **author → export → import → (rollback)**, and no step
requires a redeploy, a restart, or a container rebuild.

---

## 1. Author

Work in the dev editors (`npm run dev`, editors are a lazily-loaded dev-only
chunk). Saving in an editor writes the JSON straight into the repo `content/`
tree via the Vite content-pipeline plugin, and the running client hot-reloads
the changed config through `ConfigService.replace()`.

Adding a **new** file also means adding its path to `content/manifest.json` —
the manifest is the pack's index, and anything not listed is not part of the
pack. A file present on disk but missing from the manifest is invisible to the
server; a file listed but absent is a hard error.

Before exporting, run the same gate CI runs:

```bash
npm run validate:content
```

---

## 2. Export

### From a dev machine (offline authoring)

```bash
npx tsx tools/export-content.ts                       # → ./content-pack.json
npx tsx tools/export-content.ts --out packs/v7.json
npx tsx tools/export-content.ts --dir /srv/content --stdout > pack.json
```

The tool **validates before writing**, so a broken pack never leaves the machine
that produced it.

### From a running server (admin API)

```bash
curl -sS https://your-host/api/admin/content/export \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -o pack.json
```

Both produce the identical bundle shape and the identical `sourceHash`, so
"what is live in production" and "what is on my disk" are directly comparable —
one string, not a 55-file diff.

Only files the manifest lists are exported. Strays left in the content
directory are ignored, which means an export is exactly what a server would
load, not whatever happens to be lying around.

---

## 3. Import to production

```bash
# 1. Get an admin access token (the account must have users.role = 'admin';
#    create one with `npx tsx tools/create-admin.ts <email> <password>`).
ADMIN_JWT=$(curl -sS https://your-host/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops@example.com","password":"…"}' | jq -r .accessToken)

# 2. Import the bundle.
curl -sS https://your-host/api/admin/content/import \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H 'Content-Type: application/json' \
  --data-binary @pack.json | jq
```

Success:

```json
{
  "ok": true,
  "packId": "manifest.default",
  "packVersion": 2,
  "sourceHash": "sha256:79b20a676cd1…",
  "files": 55,
  "counts": { "arena": 2, "module": 13, "ship": 3, … },
  "rollbackAvailable": true
}
```

Failure (HTTP **422**) — nothing was written:

```json
{
  "error": {
    "code": "pack-validation-failed",
    "message": "content pack rejected at validation (1 problem(s)) — nothing was changed"
  },
  "stage": "validation",
  "errors": [
    {
      "file": "arenas/proof.json",
      "path": "asteroidPlacements[0].asteroidId",
      "message": "dangling reference: no config with id \"asteroid.does-not-exist\""
    }
  ]
}
```

`errors` is the same `{ file, path, message }` list that `npm run
validate:content` prints and that the editors render, so the response can be
pasted straight back to whoever authored the pack.

### Verify without any credentials

```bash
curl -sS https://your-host/health | jq .contentPack
```

```json
{
  "packId": "manifest.default",
  "packVersion": 2,
  "sourceHash": "sha256:79b20a676cd1…",
  "files": 55,
  "loadedAt": "2026-07-25T00:31:13.104Z",
  "rollbackAvailable": true
}
```

---

## 4. Rollback

```bash
curl -sS -X POST https://your-host/api/admin/content/rollback \
     -H "Authorization: Bearer $ADMIN_JWT" | jq
```

Restores the pack the last import replaced. Rollback is **symmetric**: the pack
it replaces becomes the new rollback target, so calling it twice returns you to
where you started. That matters at 3am, when the rollback turns out to have been
the mistake.

`409 rollback-failed` means there is nothing to roll back to — either no import
has happened since this container started, or the previous pack directory was
removed.

---

## 5. Endpoint surface

| Method & path | Limit | Notes |
|---|---|---|
| `GET /api/admin/content/export` | read bucket | The live pack as a downloadable bundle (`Content-Disposition`, `Cache-Control: no-store`). |
| `GET /api/admin/content/status` | read bucket | `{ protocolVersion, pack }` — same `pack` object `/health` exposes. |
| `POST /api/admin/content/import` | read + **write** bucket | Validate → stage → swap → reload. `200` / `422` / `413`. |
| `POST /api/admin/content/rollback` | read + **write** bucket | Restore the previous pack. `200` / `409`. |

**Gating.** Every route is behind `requireAdmin`: `401 unauthorized` for a
missing/invalid/expired token, `403 forbidden` for a valid token whose user is
not `users.role = 'admin'`. The role is read from the database on **every**
request rather than baked into the JWT, so demoting an admin takes effect
immediately instead of at the next token expiry.

**Rate limits.** Two per-IP token buckets. Reads get 20 burst / 1 per second —
enough for an operator, tight enough that an unauthenticated flood cannot hammer
the token-verify and role lookup (the limiter runs *before* the auth check on
purpose). Writes get an additional 6 burst / 1 per 10 s, because each one is a
directory swap plus a full registry reload.

**Size cap.** `POST /import` has its own body limit —
`CONTENT_IMPORT_MAX_BYTES`, default **8 MB** — rather than the 64 kb the rest of
the API uses; the real pack is ~62 kB. Over the cap is `413 pack-too-large`.
This is why the admin router is mounted *before* the global JSON parser in
`httpApp.ts`.

---

## 6. What the import actually guarantees

**Validation is not re-implemented.** The bundle is handed to `ConfigService`
with a loader that reads out of the bundle instead of off the disk. An imported
pack therefore passes *exactly* the gate that `npm run validate:content` and
server boot apply:

- every config validated against its Zod schema;
- every cross-reference resolved, with the **type** checked (`asteroidId` must
  name an `asteroid`, not a `ship`);
- duplicate ids rejected;
- relational rules checked (e.g. a ship's `defaultFitting` must fit its own
  sockets);
- `protocolVersion` must equal the server's — a pack authored against another
  wire generation is refused before anything else happens;
- file paths sanitized: no absolute paths, no `..`, no backslashes, no drive
  letters, `.json` only. Import writes to disk, so this is a security boundary;
- manifest and payload must agree in both directions: a listed-but-absent file
  and a carried-but-unlisted file are both errors.

**Ordering is the safety argument.** Validate entirely in memory → stage to a
new directory → swap → reload. Nothing is written until the pack is known-good,
and nothing is live until it is fully written.

**The swap is atomic.**

```
content.staging-<ts>/   written + fsynced, never yet visible
content/             →  content.previous/        (rename 1)
content.staging-<ts>/ → content/                 (rename 2)
```

Two renames within one directory on one volume. If rename 2 fails, rename 1 is
undone and the old pack is back before the call returns. If it succeeds,
`content.previous/` stays put as the one-step rollback. Files are fsynced before
the swap, so a crash cannot leave a directory that *looks* complete but holds
zero-length files.

Writing the files in place was rejected: `/content/*` is live traffic, and a
half-written pack is a *served* pack. There must be no window in which a client
can fetch an arena referencing an asteroid that has not landed yet.

### Binary assets do **not** travel in a pack — they are carried across the swap

A bundle carries JSON only: `files` is a map of path → parsed JSON, and the path
sanitizer accepts `.json` and nothing else. But the content *directory* holds far
more — `.glb` models, `.webp`/`.jpg` skyboxes, `.ktx2` textures, `.mp3` music —
and `writePackTo` materializes a **fresh** directory from the bundle. Staging the
bundle alone and renaming it into place would therefore delete every binary in
the live pack.

So staging is assembled from two sources:

```
writePackTo(staging, bundle)      manifest.json + the .json configs it lists
copyPackAssets(content, staging)  everything in the live pack that is NOT .json
```

The split is exact. Every `.json` file under `content/` is either listed in
`manifest.json` or is not part of the pack at all, so "is it JSON" cleanly
separates *what the bundle defines* from *what only the directory has*. Dropping
a file from the manifest still deletes it (pruning works); a model still survives
(no data loss).

Consequences to plan around:

- **Models still ship with the deployment, not with the pack.** They are part of
  the image / the volume's content tree (`server` serves the whole content dir
  statically, `.glb` → `model/gltf-binary`), and they are versioned in git.
  Authoring a new rock or hull is a deploy, not a content import. What changed is
  only that an import no longer *destroys* the ones already there.
- **Adding a binary is still a deploy.** An import can preserve assets; it cannot
  introduce them, because a JSON bundle has nowhere to put the bytes.
- **Ordering.** The copy finishes before the first rename, so a failure part-way
  through (a full disk, an unreadable file) aborts the import with the live pack
  untouched — the cost is a discarded staging directory, nothing more. A staging
  directory abandoned by a crash is swept by the next import.
- **Rollback is coherent by construction.** `content.previous/` is a complete
  directory, assets included, so restoring it restores the binaries too.
- A config whose `render.model` file is missing is **not** a validation error and
  does not break the client: `AssetRegistry.ensureModel` logs a warning and the
  entity falls back to its procedural `render.recipe`. That fallback is why a
  missing model shows up as "the rocks look wrong", never as a failed import.

### Windows caveat

`rename()` on a directory fails with `EPERM`/`EBUSY`/`EACCES` on Windows if
**any** handle inside it is open — an in-flight `express.static` read, an editor
with a file open, a shell whose working directory is inside it, or an antivirus
scanner mid-scan. The swap therefore retries with backoff (12 attempts, growing
delay), which clears every transient case; a static file read lasts
milliseconds.

A *held* handle is not transient and no retry count fixes it. In that case the
import fails with `stage: "swap"`, **the old pack is still live**, and the error
message names the cause:

```
could not swap the content directory (EPERM) — the previous pack is still live.
On Windows this means a handle inside the content directory is held open (an
editor, a shell whose working directory is inside it, or a scanner). Close it
and retry: …
```

The production container is Linux, where directory renames do not have this
problem; this matters for local prod-mode runs and Windows hosts.

---

## 7. What is live-reloadable — honestly

This is the part worth reading twice. "Without a redeploy" is true; "without
consequences for a match already in progress" is **not** what happens, and no
live-match migration system was built.

| Surface | Behaviour after a successful import |
|---|---|
| `/content/*` (HTTP) | **Immediate.** `express.static` resolves paths per request from the directory root, so the next request gets the new bytes. `Cache-Control: no-cache` means browsers always revalidate. |
| `GET /health`, `/api/admin/content/status` | **Immediate.** New `sourceHash`, `packVersion`, file count. |
| Server `ConfigService` singleton | **Immediate.** A brand-new `ConfigService` is built from the swapped directory and installed via `setConfigService()`. |
| **New** rooms / matches | **Use the new pack.** `ArenaRoom.onCreate` reads the singleton, so the next room created resolves its gamemode, arena, ships and modules from the imported pack. This is the case the proof exercises. |
| **In-flight** rooms / matches | **Keep the old pack, entirely.** A room captures the `ConfigService` instance at creation (`this.configs`) and uses it for every later lookup — joins, bot backfill, fitting resolution, end-of-match rewards. A match therefore plays out on one coherent pack from start to finish. |
| Bots in an in-flight match | Old pack (they read through the room's pinned service). |
| Already-open browser tabs | **Stale until reload.** The client loads `manifest.json` once at boot. The `config:changed` hot-reload path is `import.meta.hot` — dev only. |
| Browser tabs after a reload / new visitors | **New pack.** The service worker treats `/content/*.json` as `NetworkFirst` (`client/vite.config.ts`), so a reload fetches fresh content and falls back to cache only when offline. |

Two consequences follow, and they are deliberate rather than accidental:

1. **A match started before the import finishes on the pack it started with.**
   The alternative — swapping configs under a running simulation — would mean an
   arena's bounds or a module's heat curve changing mid-fight, which is worse
   than a brief inconsistency between two concurrent matches.

2. **A player with an open tab must reload before they can play new content.**
   If a client whose in-memory pack predates the import joins a room created on
   a brand-new arena, it has no config for that arena. In practice new content
   should be announced or gated behind a client reload; the network-first
   service worker makes that reload sufficient — no reinstall, no cache purge,
   no redeploy.

There is no server→client "content changed, reload now" push today. The wire
protocol carries orders and sim events; adding a content-invalidation broadcast
would be a protocol change, and the roadmap's stated propagation path for 6.7 is
the network-first service worker. The honest summary is: **the server updates
instantly, new matches update instantly, open tabs update on their next load.**

---

## 8. End-to-end proof

`tools/pack-proof.ts` is the repeatable proof of everything above. It boots a
**production-mode** server against a throwaway content directory and database,
and — without restarting that process — clones an arena and a module into the
exported bundle, imports them, demonstrates they are live, and rolls back.

```bash
npm run build            # once: the proof asserts a real client build is served
npm run content:proof
```

It checks the negatives too: that a non-admin gets 403 and an anonymous caller
gets 401, that a dangling reference and a `protocolVersion` mismatch are both
refused with the live pack left byte-identical, that an unknown arena is still
rejected after the import (so the positive result is not vacuous), and that the
server logged exactly one boot line and never exited.

```
── 5. Import the new pack — no restart, no redeploy
  PASS POST /api/admin/content/import → 200  status=200
  PASS import result  v2, 55 files, arenas=2, modules=13
  PASS previous pack retained for rollback

── 6. Prove the new content is live in pid 26244
  PASS /health reports a NEW pack hash  sha256:79b20a676cd1…
  PASS a fresh export now contains arenas/proof.json  55 files
  PASS …and modules/proof-lance.json
  PASS GET /content/arenas/proof.json → 200 (what the browser fetches)
  PASS …with the new bounds radius  radius=137
  PASS …served no-cache, so the SW's NetworkFirst rule always revalidates
  PASS /content/manifest.json lists the new arena
  PASS service worker keeps /content/*.json NetworkFirst
  PASS a NEW match can be created on arena.proof  roomId=EVzpWam9g
  PASS …while an unknown arena is still refused (the check is real)
```

---

## 9. Operational notes

- **Persistence.** The content directory must be on the persistent volume, next
  to the SQLite database. `content.previous/` lives beside it and needs the same
  space again — budget ~2× the pack size (~120 kB today, trivial).
- **A container restart re-reads the directory**, so an imported pack survives
  restarts. It does **not** survive a redeploy that ships a fresh image with a
  baked-in `content/` unless `CONTENT_DIR` points at the volume. Point it at the
  volume.
- **Concurrent imports are serialized** inside the store; two admins pressing
  the button at once cannot interleave two swaps.
- **`sourceHash` is provenance, not authenticity.** It answers "is this the pack
  I exported?" A bundle is trusted because the caller held an admin token, not
  because a hash matched — which is why the import deliberately ignores the
  hash a caller supplies and validates the contents instead.
- **Keep the pack in git.** The admin API is for getting content live now; the
  repository is still the source of truth, and `npm run validate:content` in CI
  is what stops a bad pack from ever being exported.
