# Balancing report — Orion's Arm

> **Update 2026-08-15 — re-measured after the shielded/bare damage rewrite.**
> The damage model was restated (shielded and bare as independent cases per
> type; missile damage and cooldown both doubled) and all 20 matches re-run on
> the same seeds. The changes moved the numbers in the intended direction, and
> the before/after is in [Effect of the damage rewrite](#effect-of-the-damage-rewrite)
> at the end. The body below is the ORIGINAL measurement that motivated it, kept
> because the recommendations were written against it.

Generated 2026-08-15 from **20 complete bot-vs-bot matches** (10 × CTF 5v5 on
`arena.lunar-rift`, 10 × deathmatch 5v5 on `arena.deep-field`), played headless
in the deterministic simulation by `tools/match-tracker.ts` and aggregated by
`tools/balance-report.ts`.

Reproduce with:

```bash
npx tsx tools/match-tracker.ts --mode ctf --matches 10 --seconds 600 --out .balance/ctf
npx tsx tools/match-tracker.ts --mode 5v5 --matches 10 --seconds 600 --out .balance/5v5
npx tsx tools/balance-report.ts .balance/ctf .balance/5v5
```

Every match is seeded (1000, 1007, … 1063), so the numbers below are exactly
reproducible. Both teams field an identical hull composition each match — the
harness assigns hulls by seat index *within a team*, because a global counter
handed one side a second brawler and produced a fake 10-of-10 side bias on the
first run. That is worth remembering when reading any future run: an apparent
side advantage is a harness bug until proven otherwise.

---

## Headline findings

1. **CTF never reaches its win condition.** 0 of 10 matches ended; all ten hit
   the 600 s cap. The mode is first-to-3 captures and bots average **0.7
   captures per match**.
2. **The flag almost never gets home.** 200 flags taken, 189 dropped, **7
   captured — a 3.5% conversion rate**. Carriers die.
3. **The brawler dominates both modes.** K/D **1.68** (CTF) and **1.79** (DM)
   against the interceptor's **0.49** and **0.45**. With 40% of the seats it
   deals **~60% of all damage in the game**.
4. **The interceptor is not a viable hull.** It dies roughly twice for every
   kill it scores, in both modes, and takes more damage per minute than it deals.
5. **Energy weapons pay a heavy shield tax; kinetic pays almost none.** 27–32%
   of energy output is spent on shields versus **2.8–3.3%** of kinetic. This is
   the typed-damage triangle working as designed — but combined with energy's
   0.5 hull multiplier it makes lasers strictly the worst damage per shot.
6. **Combat is slow, especially in CTF**: median time-to-kill **36.3 s** in CTF
   and **14.9 s** in deathmatch.

---

## Per-hull performance

### CTF (10 matches, 600 s each)

| hull | pilots | K | D | A | K/D | dmg dealt/min | dmg taken/min | share of all damage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| brawler | 40 | 569 | 339 | 318 | **1.68** | 218.5 | 219.8 | **57.7%** |
| interceptor | 40 | 227 | 462 | 416 | **0.49** | 99.1 | 158.9 | 25.6% |
| support | 20 | 177 | 173 | 220 | 1.02 | 127.1 | 176.9 | 16.8% |

### Deathmatch 5v5 (10 matches, median 128 s)

| hull | pilots | K | D | A | K/D | dmg dealt/min | dmg taken/min | share of all damage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| brawler | 40 | 328 | 183 | 245 | **1.79** | 726.4 | 620.6 | **59.9%** |
| interceptor | 40 | 94 | 207 | 351 | **0.45** | 324.9 | 348.8 | 26.3% |
| support | 20 | 56 | 88 | 153 | 0.64 | 335.9 | 500.5 | 13.8% |

The two modes agree closely, which makes this a property of the hulls rather
than of one map or ruleset. The interceptor's damage *taken* per minute exceeds
its damage *dealt* in both — it loses its exchanges on average, not just at the
margins.

---

## Time to kill

Measured from a victim's first damage taken to its death, so it includes any
disengagement in between — treat it as "how long a fight lasts", not as a pure
DPS calculation.

| killer → victim | CTF median | DM median |
|---|---:|---:|
| brawler → interceptor | **24.3 s** | **9.8 s** |
| support → interceptor | 29.4 s | 14.5 s |
| brawler → support | 33.2 s | 16.0 s |
| interceptor → interceptor | 37.8 s | 18.3 s |
| brawler → brawler | 40.5 s | 16.5 s |
| support → brawler | 44.4 s | 23.4 s |
| support → support | 44.4 s | 13.1 s |
| interceptor → support | 53.4 s | 19.2 s |
| interceptor → brawler | **54.5 s** | 17.9 s |

**The brawler-versus-interceptor matchup is the single worst cell.** In CTF the
brawler kills the interceptor in 24.3 s while needing 54.5 s to die to one — a
**2.24 : 1** asymmetry. The light hull has no answer: it is neither fast enough
to disengage profitably nor strong enough to trade.

---

## Damage types

| type | share of output | wasted on shields (CTF) | wasted on shields (DM) |
|---|---:|---:|---:|
| energy (lasers, beams) | 37–40% | **27.1%** | **32.1%** |
| kinetic (autocannons) | 33–35% | 2.8% | 3.3% |
| hybrid (missiles) | 27–28% | 9.4% | 13.6% |

The triangle behaves exactly as authored — shields soak 80% of energy and 20% of
kinetic — but the *combination* with hull effectiveness is punishing. An energy
shot that reaches a hull is also halved (0.5 hull multiplier), so against a
shielded target a laser delivers roughly **10% of nominal** to hull while an
autocannon delivers **80%**. Energy's compensating role is stripping shields,
but shields are a small fraction of effective HP here, so that role rarely pays.

---

## Objective play (CTF)

| metric | value |
|---|---:|
| flags taken | 200 |
| flags dropped | 189 |
| flags captured | **7** |
| conversion | **3.5%** |
| captures per match | 0.70 |
| matches reaching first-to-3 | **0 / 10** |

A flag carrier survives the trip home about one time in thirty. The mode's
scoring condition is effectively unreachable, so every CTF match is decided by
the clock rather than by play.

---

## Recommendations

Ordered by impact. Each names the file to change, and each is a hypothesis to be
re-measured with the same 20-match run rather than a certainty.

### 1. Make the flag survivable to carry — CTF is otherwise not a mode
`content/gamemodes/practice-ctf-5v5.json`

3.5% conversion means the objective is decoration. Pick from, and re-measure:

- Lower the win condition from 3 captures to **1–2** so a match can end at the
  observed capture rate, *and/or*
- give the carrier a defensive buff (damage resistance or a speed boost) so a
  runner who breaks contact can finish the trip, *and/or*
- shorten the run: the lunar-rift bases sit 510 units apart, which at observed
  speeds is a long time under fire.

The cheapest experiment is the win condition; the most interesting for play is
the carrier buff, because it creates a "stop the runner" moment the mode
currently lacks.

### 2. Fix the interceptor
`content/ships/interceptor.json`

K/D of 0.45–0.49 across 80 pilot-matches is not a role, it is a trap pick. Its
identity should be speed and disengagement, so the lever should be mobility and
survivability rather than raw damage:

- more speed and/or boost capacity, so a losing fight can be broken off;
- a smaller effective profile or better shield recharge, so hit-and-run is
  repeatable;
- **not** simply more DPS — that would make it a small brawler and flatten the
  roster.

### 3. Bring the brawler back to the pack
`content/ships/brawler.json`

60% of all damage from 40% of the seats, with the best K/D in both modes. It is
the only stock hull carrying the autocannon, which was given 6× its original
cadence in the 2026-08-14 pass, so some of this is weapon rather than hull. Try
the weapon first (see 4) and re-measure before touching the hull, so the two
changes are not confounded.

### 4. Re-examine the autocannon's cadence, and energy's double penalty
`content/modules/kinetic-*.json`, `content/tuning/default.json`

Kinetic wastes ~3% of its output on shields; energy wastes ~30% *and* is halved
against hull. Two candidate corrections:

- **Raise energy's hull multiplier** from 0.5 (say to 0.65–0.7). This directly
  attacks the "lasers are strictly worse" problem without touching cadence.
- **Reduce kinetic's shield penetration** from 0.8, so shields are meaningful
  against the weapon that currently ignores them.

Change one at a time and re-run — these two interact.

### 5. Consider whether missiles should be hybrid at all
`content/modules/missile-*.json`

Hybrid was introduced so missiles split 50/50 between the profiles, but the
result is a weapon that is mediocre against both defences: 0.75 hull
effectiveness and 50% shield soak. Missiles now contribute the smallest share of
damage (27%) despite being on every hull. Either give them a distinct role
(burst alpha, or anti-shield) or return them to kinetic.

### 6. Match pacing
`content/gamemodes/*.json`

A 36 s median TTK in CTF means fights are long grinds; deathmatch at 14.9 s
feels closer to right. Note the CTF figure is inflated by bots breaking off, but
the gap between the modes is large enough to look at deliberately.

---

## Caveats

- **Bots, not players.** Bot target selection, disengagement and objective play
  differ from human play; the objective findings especially are as much a
  statement about bot behaviour as about tuning. A human CTF run would very
  likely convert flags better than 3.5%.
- **TTK includes disengagement**, so it overstates pure damage-race duration —
  it is comparable *between* rows here, not against a DPS calculation.
- **Per-weapon attribution is by damage type, not module.** The sim's damage
  events carry a damage type but not the module that fired, so "energy" covers
  lasers and beams together. Adding a module id to the damage event would make
  per-weapon tuning measurable and is a small, worthwhile change.
- **Stock fittings only.** Every pilot flies its hull's `defaultFitting`, so
  this measures the shipped loadouts, not the fitting space.

---

## Effect of the damage rewrite

Re-measured 2026-08-15 on the same 20 seeds, after the damage rules were
restated as two independent cases per type and missiles had both their damage
and their cooldown doubled:

| type | shield up → reserve | shield up → hull | bare hull |
|---|---:|---:|---:|
| energy (lasers, beams) | 1.0 | 0.0 | 0.5 |
| kinetic (autocannons) | 0.2 | 0.2 | 1.0 |
| hybrid (missiles) | 0.5 | 0.0 | 1.0 |

### What moved (CTF, 10 matches)

| metric | before | after |
|---|---:|---:|
| brawler K/D | 1.68 | **1.56** |
| interceptor K/D | 0.49 | **0.54** |
| support K/D | 1.02 | **1.22** |
| brawler share of all damage | 57.7% | **51.9%** |
| brawler → interceptor TTK | 24.3 s | 22.1 s |
| interceptor → brawler TTK | 54.5 s | **41.3 s** |
| worst-matchup asymmetry | **2.24 : 1** | **1.87 : 1** |
| missile share of damage | 27.4% | **41.6%** |
| kinetic share of damage | 32.6% | 25.2% |
| energy share of damage | 40.0% | 33.1% |

Deathmatch agrees: brawler K/D 1.79 → 1.76, interceptor 0.45 → **0.56**, brawler
damage share 59.9% → **54.9%**.

**Reading it.** Three of the report's four headline problems improved without
anyone touching a ship file. The brawler gave up nearly six points of damage
share, the interceptor climbed off the floor in both modes, and the worst
matchup in the game tightened from 2.24:1 to 1.87:1 — mostly because the
interceptor kills a brawler thirteen seconds faster than it used to.

**Missiles are now the strongest weapon in the game**, up from the weakest:
41.6% of all damage, because a warhead that lands FULL on a bare hull is a
finisher, and doubling its damage while doubling its cooldown left sustained
output flat but made every individual hit decisive. That is a deliberate design
shape (burst alpha) rather than a regression, but it is worth watching — if
missiles start to feel oppressive, the lever is `bareHull` for `hybrid` in
`content/tuning/default.json`, not the module damage.

**Kinetic fell** from 32.6% to 25.2%, which follows directly from the rules: an
autocannon now spends 60% of each round on a live shield's surface, delivering
only 0.2 + 0.2. It is still the best answer to an unshielded target.

### What did NOT move

**CTF still never finishes.** 0 of 10 matches reached first-to-3, and flag
conversion did not improve — a 20-seed sweep found only 2 seeds delivering a
capture inside 180 s, down from 12. Carriers die *faster* now, because a runner
under fire is a bare hull and both kinetic and missiles land full on one.
Recommendation 1 (make the flag survivable to carry) is therefore more urgent
after this change, not less: the damage rewrite fixed the hull triangle and made
the objective problem worse.

### Method note

Same seeds, same harness, same hull composition per team, so these columns are
directly comparable. The one caveat from the original report still applies: this
is bot play, and the objective numbers are as much a statement about bot
behaviour as about tuning.
