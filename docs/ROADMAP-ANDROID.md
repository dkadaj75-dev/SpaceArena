# SpaceArena — Roadmap to Google Play

**Written:** 2026-08-08 · **Owner target:** published on the Android store
**Ground truth:** the two 2026-08-07 audits (`docs/audits/`), current shipped state (heat/energy overhaul, four-layer bot tree, shop at price-zero, tutorial in build).

The engine is ahead of the product: deterministic sim, server-authoritative netcode,
2,000+ tests, 20-room headroom. What stands between today and a store listing is
content polish, product surface, and packaging — in that order of effort.

Durations assume the current build cadence (agent-assisted, owner directing).
Phases overlap where marked. **Realistic total: ~4 months to production rollout.**
Aggressive-but-possible: 3 months. The long pole is Phase 3 by design.

---

## Phase 0 — Launch blockers (1–2 weeks) — *nothing below matters until these are gone*

From the audits, still open:

- **Reward gate inverted** (`ArenaRoom.ts` `rewardsEligible = minPlayers === undefined` vs the matchmaker passing `minPlayers: 2`): matchmade PvP pays nothing, client-created rooms pay. One-line root, test pinned.
- **Matchmaking has no low-population story**: unbounded wait, no timeout, no bot backfill, no cancel prompt. Modal outcome of the only Online button at low pop is a hang. Ship: wait estimate + N-second timeout → offer bot match.
- **2,775 ms main-thread freeze at CTF start** (regolith generation): move to a worker or pre-bake; on a phone this is an ANR risk, not a hiccup.
- **iPad/phone quality probe early-return** (`qualityTier.ts`): every mobile device gets Ultra. Mobile perf work is meaningless until the probe is honest.
- **Deploy discipline**: deploy is not CI-gated (went live before tests finished on 7 of 7 sampled merges), no version in the bundle, no rollback, no DB backups. Android review cycles make silent bad deploys far more expensive.
- **Friend/foe by hue alone** (1.02:1 luminance): shape/brightness channel for colorblind players. A store launch without it invites 1-star accessibility reviews.

**Exit gate:** matchmade duel pays credits; queue resolves ≤30 s (human or bot); CTF start <300 ms main-thread; phones get honest tiers; deploy gated + versioned + revertible; colorblind pass.

## Phase 1 — First-session experience (1–2 weeks, overlaps P0)

- **Tutorial** (in build now): fly → shoot → heat/energy → lock → dummy kill → weak bot → first fitting → shop presentation. Later: auto-offer on first launch (store users won't find a menu button).
- Sane first-fit defaults; hangar simplifications (SHIP section fold — in build now).
- Session telemetry: funnel events (tutorial completion, first match, first purchase) — you cannot tune a store page without them.

**Exit gate:** a fresh player reaches their first kill without external help; funnel numbers flowing.

## Phase 2 — Retention spine (2 weeks, overlaps P3)

- Rewards on ALL modes (five of six currently pay zero — CTF, the flagship, is progression-dead).
- Daily/first-win bonuses; simple contract-style goals (data-driven, they're content).
- Shop prices go nonzero (a content edit by design) + credit sinks tuned from telemetry.
- Player levels visible; unlock cadence tuned so the first evening always unlocks something.

**Exit gate:** D1 retention measurably moved in beta cohort; every mode pays.

## Phase 3 — Graphics & assets polish (6–8 weeks — THE LONGEST, runs parallel to everything after P0)

The game must *look* like the screenshots a store shopper judges in 3 seconds.

**3a. Ships (2 wk)** — hero-quality hulls: proper PBR texture sets (albedo/normal/AO/metal-rough), engine glow, damage states, silhouette distinct per class at range. Paints upgrade from tints to authored texture variants (the cosmetic schema's `kind` enum was built for this).

**3b. MODULES VISIBLE AGAIN (1–2 wk) — owner-flagged milestone.** Module meshes return to hardpoints: each fitted weapon/utility renders its own mount model on the hull (the `EntityView` mount system exists and is tested — it needs models and a re-enable, then per-module mk-tier visual variants). Your fitting choices readable at a glance, on your ship and the enemy's.

**3c. Maps (2–3 wk)** — full art pass per arena (5): lunar-crater got its realism pass; ring-nebula, twin-titans, broken-halo, deep-field to the same bar. Skyboxes, fog/lighting moods, landmark silhouettes for navigation, floor materials.

**3d. VFX (1–2 wk)** — weapon-family projectile/beam identities, impacts/shield hits, boost trails, jettisoned heatsink flare, explosion polish on mobile budgets.

**3e. UI & brand (1 wk)** — icon set for all 57 modules, ship renders for shop/hangar cards, loading-screen arena art (slots exist), app icon, Play feature graphic, screenshot set, short trailer capture.

**3f. Mobile performance passes (continuous)** — every asset lands within per-tier budgets on real Adreno/Mali test devices; Low tier must hold 60 fps on a 2022 mid-ranger.

**Exit gate:** store-listing screenshots taken from the real game with zero shame; 60 fps mid-range.

## Phase 4 — Standalone designer tooling (2–3 weeks, overlaps P3 — in review now)

The editor constellation (Map / Asset / Action-Event / Notification / Theme / Tuning /
Progression + Bot-profile and Balance-bench as the genre editors) becomes **standalone**:
reachable in the deployed build behind an owner login, every config type editable with
schema validation + live preview, content packs import/export, balance bench runnable
from the Tuning panel. Owner edits everything — variables and assets — with no code round-trip.
(Being built as its own workstream; the roadmap only sequences it.)

**Exit gate:** owner ships a balance change and a new paint end-to-end without a developer.

## Phase 5 — Android packaging (2–3 weeks, after P0, overlaps P3)

- **Wrapper decision:** TWA/Bubblewrap (thin, Play-accepted, the PWA runs in Chrome) vs **Capacitor** (WebView + native APIs). **Recommendation: Capacitor** — needed eventually for Play Billing, notifications, keep-awake, reliable fullscreen/orientation lock, and it removes the SW-update wedge class (bundled assets version atomically with the app).
- Lifecycle correctness: pause/resume mid-match, audio focus, back-button semantics, cut-outs/notches, refresh-rate handling.
- Touch latency + haptics pass on device; WebGL context-loss recovery.
- 64-bit, current target API level, app signing by Google, `versionCode` discipline wired to the (new, P0) build versioning.
- Server: production host with backups (P0), region latency check, `trust proxy`.

**Exit gate:** signed AAB installs and plays a full CTF on 3 physical devices (low/mid/high) without lifecycle bugs.

## Phase 6 — Closed testing (3–4 weeks, calendar-bound by Google)

- Play Console setup: **new personal dev accounts must run a closed test with ≥12 testers for 14 continuous days before production access** — schedule it early, it's a hard calendar gate.
- Crash reporting + ANR watch; balance tuning from real-device telemetry.
- Data safety form, IARC content rating, privacy policy page (server collects accounts → policy is mandatory), account deletion path (Play requirement for apps with accounts).
- Store listing drafts A/B'd on testers.

**Exit gate:** 14-day test clean (crash-free ≥99.5%), forms approved.

## Phase 7 — Launch (1 week)

Staged rollout 10% → 50% → 100% with rollback ready; pre-registration optional; day-one hotfix slot reserved; store assets final from P3e.

## Phase 8 — Post-launch (ongoing)

Play Billing for credits/paints (15% fee tier ≤ $1M/yr), seasonal paints, rating system before any competitive monetization, content cadence via the P4 tools.

---

## Sequencing at a glance

```
Weeks:      1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16
P0 blockers ██ ██
P1 first-run██ ██
P2 retention      ██ ██
P3 graphics       ██ ██ ██ ██ ██ ██ ██ ██        (longest)
P4 tools          ██ ██ ██
P5 packaging            ██ ██ ██
P6 closed test                   ██ ██ ██ ██     (14-day Google gate inside)
P7 launch                                     ██
```

Module visibility (3b) lands around weeks 4–6. Everything in P2/P4 is content/data
by construction, so it compounds with the tools instead of competing with them.
