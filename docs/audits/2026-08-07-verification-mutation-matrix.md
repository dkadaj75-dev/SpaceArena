# Verification mutation matrix — proving the balance/behaviour gates can fail

**Date:** 2026-08-07
**Subject:** `shared/src/sim/balanceRegression.test.ts`, `shared/src/bots/*.test.ts`, the
content schema invariants, and the standalone benches in `tools/`.

## Why

The 2026-08-07 project audit found the previous balance bench structurally blind:
`timeToKill()` never asked whether the attacker survived, and `runEngagement()`
restored hull every tick. It therefore certified a heat economy in which the
starter loadout killed its own pilot — 58.8% of all damage self-inflicted, 13 of
19 deaths from the pilot's own heat — while reporting green.

The bench was rebuilt as part of the heat/energy overhaul. **Rebuilt is not
proven able to fail.** This document records a mutation test of the whole
verification layer: each guardrail was deliberately broken and the gates re-run,
to establish which regressions actually trip a gate and which pass through it.

Method: apply one mutation to the working tree, run only the relevant vitest
file(s), record the exact failing assertion, revert, confirm `git diff` is empty,
move on. Serial, never more than one mutation live. All runs were done in an
isolated `git worktree` so a concurrent session in the main tree could not
pollute the baselines, with `node_modules/@space-arena/*` repointed into the
worktree so `@space-arena/shared` resolved locally rather than leaking the other
tree's sources.

Baseline on clean HEAD: `npx vitest run` — 168 files, 1899 tests, all passing.

---

## The matrix

| # | Mutation | Expected tripwire | Actual result | Action taken |
|---|---|---|---|---|
| 1 | `module.laser-mk1` `heat.perShot` ×20 (28.9 → 578) | bench red (TTK out of band or `attackerDied`) | **RED — at load.** `ConfigService`: `heat.perShot (578) must stay below heat.capacity (100) — one shot may never lock its own rack`. The whole suite fails to collect; `npm run validate:content` also fails. | none — caught earlier than expected |
| 1b | `heat.perShot` ×3 (28.9 → **86.7**), schema-legal | bench red | **RED — 14 tests.** `module.laser-mk1 burn: expected 0.0997 to be greater than 1.5`; `expected 27 to be 13` (interceptor overheat count); `ship.interceptor vs ship.brawler: expected 50.467 to be less than 45`; six TTK band violations. | none — the bench sees schema-legal heat inflation |
| 2 | `ship.interceptor` `core.heatStore.multiplier` 1.0 → 0.2, so one laser shot (28.9) exceeds the rack (20) | schema invariant and/or bench red | **RED — 6 tests.** `module.laser-mk1: one shot (28.9) must stay below the smallest hull's rack (20): expected 28.9 to be less than 20`, plus overheat-count and heat-model-stress failures. **`npm run validate:content` stayed GREEN** — the schema invariant compares `perShot` to the module's own `capacity` and cannot see the hull's `heatStore` multiplier. | none — vitest covers it; noted below as a gate-surface asymmetry |
| 3 | Bench self-blindness A: restore the subject's hull every tick inside `runEngagement` | some assertion still fails | **STAYED GREEN — 25/25 passed.** Real blind spot: every `hullLost === 0` assertion, including the one titled "A SHIP CAN NEVER HURT ITSELF BY FIRING", becomes vacuously true and nothing else notices. This is the *exact* defect the rebuild was written to remove, re-introducible in one line. | **fixed** — added the live-probe positive control (below). Re-run under the same mutation: **RED**, `hull probe is not wired to the subject's hull: expected 0 to be greater than 0` |
| 4 | Bench self-blindness B: `timeToKill` reports `killed` unconditionally | red somewhere | **RED — 1 test.** `nobody dies out of range: expected 'killed' to be 'neither'`. Only the out-of-range case objects; the nine-matchup matrix accepts it silently. | strengthened (see 4b) |
| 4b | Narrower: delete only the `if (!sim.hasShip(attacker))` discriminator — the original bug verbatim | red | **STAYED GREEN — 25/25 passed.** Real blind spot: no shipped matchup kills its attacker, so the `attackerDied` branch is never reached on a clean tree. The single change that caused the original mis-certification can be reverted and the suite still certifies. | **fixed** — added the attacker-death positive control (below). Re-run under 4b: **RED**, `an unarmed pilot under fire must read as attackerDied, got "neither"`. Under mutation 4: **RED**, `got "killed"` |
| 5 | `module.laser-mk1` `fire.cycleTime` 0.5 → 10000 | TTK band red | **RED — 14 tests.** `module.laser-mk1: must out-pace its own cooling or heat means nothing: expected 0.00289 to be greater than 40`; `expected 79.3 to be less than 45`; six band violations. `validate:content` green. | none |
| 6 | `module.laser-mk1` `fire.damage` ×10 (2.41 → 24.1) | TTK **lower** band red | **RED — 9 tests.** `expected 2.167 to be greater than 8` on every matchup. The band is two-sided (`TTK_FLOOR_S = 8` / `TTK_CEILING_S = 45`); no lower bound needed adding. | none |
| 7 | `module.heatsink-basic` `cooling.multiplier` 1.6 → 0.01 | sustained-fire/uptime or TTK red | **RED — 15 tests.** `module.laser-mk1 burn: expected 1.235 to be greater than 1.5`; `expected 2 to be 13`; and every matchup flips to `ended "neither"` — nobody can kill anybody. `validate:content` green. | none |
| 8 | `module.boost-mk1` `energy.drawPerSec` → 2000, `capacity` → 1 | something red | **STAYED GREEN — full `npx vitest run`, 1899/1899 passed.** Two findings: (a) `module.boost-*` is **unfittable dead content** — no ship socket in the pack `accepts: ["boost"]`, so mutating it is correctly harmless; (b) it exposed that no gate measures boost at all. Re-ran against a *fittable* boost drive: | see 8b/8c |
| 8b | `module.engine-sport` `drawPerSec` → 2000, `capacity` → 1 (boost window 2.77 s → 0.07 s) | something red | **RED — 1 test, incidentally.** `Ctf.test.ts > flies slower with the flag than the same hull flies without it: expected 31.049999999999997 to be less than 31.049999999999994` — a float comparison that happens to collapse when the tank empties mid-measurement. Nothing asserts a boost *duration*. | **fixed** — new `heatFeel.test.ts` boost bands |
| 8c | `module.engine-sport` `drawPerSec` 20 → 60 (boost window 2.77 s → 0.93 s — a third of the feel target, still fully functional) | something red | **RED — the same single incidental float test.** A change that cuts the sprint drive's boost to a tap is caught only by an assertion about flag-carrier speed, with a failure message that says nothing about boost. | **fixed** — re-run with the new suite: **RED**, `module.engine-sport boost window: 0.93 outside 2.77 ±0.4` and `expected 0.93 to be greater than 2` |
| 9 | `decideFire` returns `{ fire: false }` unconditionally | a bot integration test red | **RED — 20 tests** across four files. `flies, locks, fires and lands hull damage inside a bounded match: expected 0 to be greater than 3`; `bots play capture the flag > actually score: expected 0 to be greater than 0`; `keeps tuned marksmanship honest: perfect={"fired":0,...}: expected 0 to be greater than 8`. Bots that never fire cannot be certified. | none — coverage is already deterministic and specific |
| 10 | `BotDriver` emits `throttle: 0` on every flight order | red in bot movement/capture tests | **RED — 16 tests.** `get the flag off its stand and run with it: expected 0 to be greater than 0`; `delivers a carried flag from a broadside approach: carrier distance to home each second: 100.00, 100.00, …`; `separates a zero-throttle bot parked nose-first…: expected 0 to be greater than or equal to 4`. Displacement is already asserted, with legible evidence in the message. | none |

---

## Blind spots found, and what closed them

Three mutations passed a full gate run. Two were in the bench's own ability to
observe; one was a whole unmeasured axis.

### 1. The hull probe could be silently unwired (mutation 3)

`runEngagement` asserts `hullLost === 0` on every hull. That is only evidence if
`hullLost` can be non-zero — and one added line restoring the subject's hull made
it permanently zero with no other assertion objecting.

Closed with a positive control in the same bench: the identical scenario run
against an **armed** partner, requiring the number to move.

```
scripted 60 s engagements — per-module heat/energy regression bands
  > PROVES THE HULL PROBE IS LIVE: the same bench records real damage when it is dealt
```

`runEngagement` gained a `{ returnFire }` option (partner keeps its weapons, gets
a fire order and a pinned lock; the subject's death short-circuits the scenario).

### 2. The attacker-death discriminator was never exercised (mutation 4b)

`KillResult.attackerDied` is the entire point of the rebuild, and no shipped
matchup reaches it — so the branch could be deleted, restoring the original
`Infinity`-collapsing bug, with the suite green.

Closed with a positive control that inverts one duel:

```
TTK sanity bounds (default fittings, weapons hot)
  > PROVES THE ATTACKER-DEATH DISCRIMINATOR IS LIVE: a pilot who dies is reported as one
```

`timeToKill` gained a `{ reverse }` option (defender shoots, attacker unarmed).
The matrix's failure message was also corrected — it previously printed
`attacker died at Xs` for *any* non-kill outcome, including `neither`, which is
the same conflation the rebuild removed from the logic but left in the prose.

### 3. The feel identities were asserted nowhere (mutations 8/8b/8c)

The overhaul's acceptance numbers — a mk1 rack burns ~5 s, cools in ~2.5 s, a
sprint drive holds boost ~3 s — lived only in `tools/heat-feel-bench.ts`, which no
gate runs. `balanceRegression.test.ts` pins the *arithmetic* of burn and recovery
from the content numbers (so a sim-side change is invisible to it) and pins
nothing at all about boost.

Closed with a new suite that **measures** the identities in the simulation:
`shared/src/sim/heatFeel.test.ts` — 9 tests, on the free hull, on a private
asteroid-free bench arena at a fixed 30 Hz with no RNG consumer.

- Weapon thermal feel per free-kit rack: burn, lockout, recovery and **uptime**
  (the share of a held 60 s trigger the rack was live), each with a tolerance.
  Uptime is the number an edit can move without touching any TTK literal.
- Boost feel per mountable boost drive: active window and recharge, anchored per
  module, plus class bounds (a burst, never a cruise mode or a tap; refilling
  always costs more than the burst).
- A roster check, so a new boost drive cannot ship without an anchor.

---

## Gate surface audit

`npx vitest run`, `npm run typecheck`, `npx eslint .` and `npm run
validate:content` are the standard gates. The standalone tools are **not** run by
any of them:

| Tool | What it measures | Mirrored in a gate? |
|---|---|---|
| `tools/heat-feel-bench.ts` | weapon burn/lockout/recovery/uptime/sustained DPS, energy module active+recharge windows, the TTK matrix | TTK matrix: **yes** (`balanceRegression.test.ts`). Burn/recovery: previously arithmetic-only. Uptime and boost windows: **no** — now covered by `heatFeel.test.ts`. Energy-module (shield) windows: still tool-only. |
| `tools/bot-ctf-review.ts` | per-bot distance, near-zero-speed fraction, shots/min, rack lockout fraction, carrier runs, stuck windows, captures | Substantially **yes** — `CtfBots.test.ts` asserts captures, carrier displacement and flag legality; `BotIntegration.test.ts` asserts shots/min bounds and heat-under-load behaviour. Mutations 9 and 10 both went red through these. Stuck-window and lockout-fraction telemetry remain tool-only diagnostics. |

Two asymmetries worth recording rather than fixing here:

- **`validate:content` is narrower than the bench.** Mutations 2, 5, 7 and 8 all
  pass content validation and are caught only by vitest. The schema's
  "one shot may never lock its own rack" invariant compares a module against its
  own `capacity` and cannot see a hull's `heatStore` multiplier; the cross-product
  check lives in `balanceRegression.test.ts` instead. Content edits must therefore
  be gated on `npx vitest run`, not on `validate:content` alone.
- **`module.boost-mk1/mk2/mk3` are unfittable.** No socket in `content/ships/`
  accepts the `boost` family, so all three are dead content; boost reaches the game
  only through the boost-capable engines (`engine-agile`, `engine-endurance`,
  `engine-racing`, `engine-sport`), none of which is free or level 1. Left alone —
  it is a content decision, not a verification defect — but it is why mutation 8
  was correctly harmless.

---

## Evidence: every new test fails under its target mutation and passes clean

| New test | Clean HEAD | Under its target mutation |
|---|---|---|
| `PROVES THE HULL PROBE IS LIVE` | PASS (27/27 in file) | mutation 3 → `hull probe is not wired to the subject's hull: expected 0 to be greater than 0` |
| `PROVES THE ATTACKER-DEATH DISCRIMINATOR IS LIVE` | PASS | mutation 4b → `got "neither"`; mutation 4 → `got "killed"` |
| `heatFeel` — pulse laser burn/lockout/recovery/uptime | PASS (9/9 in file) | mutation 7 → `laser-mk1 burn: 1.63 outside 5.37 ±0.6` and `uptime: expected 0.03 to be greater than 0.6`; mutation 1b → `burn: 0.57 outside 5.37 ±0.6` |
| `heatFeel` — missile rack | PASS | mutation 7 → `missile-mk1 burn: 1.27 outside 6.07 ±0.6` |
| `heatFeel` — boost windows | PASS | mutation 8c → `module.engine-sport boost window: 0.93 outside 2.77 ±0.4`; mutation 8d (`capacity` → 1) → `0.07 outside 2.77 ±0.4` |

## Final gate state (clean tree, all mutations reverted)

```
npm run typecheck        exit 0
npx eslint .             exit 0
npx vitest run           169 files, 1910 tests, all passing   (was 168 / 1899)
npm run validate:content 116 configs loaded
```

Playwright was not run.

## Files changed

- `shared/src/sim/heatFeel.test.ts` — **new**, 9 tests pinning the measured feel identities.
- `shared/src/sim/balanceRegression.test.ts` — two positive controls, the
  `returnFire` / `reverse` options they need, and a corrected failure message.
- `docs/audits/2026-08-07-verification-mutation-matrix.md` — this document.

No production code was changed.
