# Playtest report — agent `match` (online play, HUD, netplay, combat VFX)

Build: HEAD `7745ef2`, dev server `:5173` + game server `:2567`. Device profile: 915×412 landscape, DPR 2.625, `isMobile`/`hasTouch`, Android Chrome UA. Accounts registered by this agent: `playtest-match-a`, `playtest-match-b` (shared dev admin not used).

**Artifacts: `playtest/match/` — 484 screenshots in `shots/`, 24 console captures in `logs/console-*.log`, per-match timelines `logs/timeline-*.txt`, audio capture `logs/audio-cues.json`, contact sheets `logs/sheet-*.png`.**

## Rig notes (findings in themselves)
Headless Chromium with SwiftShader rendered correctly but ran at **0.7 fps** and took **>45 s to process one click**; everything therefore ran **headed** on the real GPU. Even headed, the first ~4 s after boot blocks input (28 s per click), so the rig waits for ≥20 fps before touching anything. Input is real multi-touch over CDP `Input.dispatchTouchEvent` — which is what surfaced finding #1.

## Matches played
| # | Mode | Composition | Duration | Result |
|---|---|---|---|---|
| 1 | Duel 1v1, Ring Nebula | A vs B, **human v human, no bots** | ~35 s combat | A DEFEAT / B VICTORY (0–1, elimination) |
| 2 | 2v2 TDM, Ring Nebula | A(t0)+bot vs B(t1)+bot, one room | ~75 s | A DEFEAT 5–10; B MVP 8 kills; A died/respawned 4× |
| 2b | 2v2 TDM (mis-queued) | A and B in **separate rooms** (#15) | ~80 s | A defeat 4–10 |
| 3 | 5v5 CTF, Lunar Rift | A + B + 8 bots | **~5 min**, left via pause menu at 0–0 / 6:54 | left deliberately |
| 4 | 5v5 TDM, Ring Nebula | A + 9 bots, quality pinned HIGH | to frag limit | VICTORY, 25 frags |

Plus five instrumented micro-sessions (real online rooms) for the flight-control, click, room-pairing, audio and hangar audits.

## Findings

**[BUG] 1 — While a finger is on screen, every `click`-bound HUD control is dead.** In a live 2v2 (`clickcheck.mjs`): with no finger down, SHIELD goes `retracted → active` (sim confirms), SCORE opens the scoreboard, the gear opens settings. **With the steering thumb held, all three do nothing.** `pointerdown`-driven controls (weapon triggers, BOOST, JETTISON) work either way. On a phone you steer by holding a thumb, so in normal flight the shield, scoreboard and pause menu are unreachable. Observed live in CTF: `332-ctf-a-scoreboard-in-match.png` / `333-ctf-a-settings-in-match.png` are just the plain HUD; timeline records `scoreboard opened: false`, `quit-to-menu offered in pause: 0`, and the shield never left `state-retracted` for the whole match.

**[BUG] 2 — The Hangar module sheet hides most of its list with no affordance.** `631-ch-sheet.png`: the sheet is 519 px wide and shows 5 cards; the row holds 21. The 6th — **Sustained Beam Mk I, owned free** — starts at x=534, clipped away. No arrow, no peeking card, no scrollbar. Clipped cards still report on-screen bounding boxes, so a tap at the reported centre silently does nothing (`beamfit.mjs`: card `disabled:false`, tap at (582,358), slot unchanged — twice, on both hardpoints). `cardhit.mjs` shows the hit test resolving to `.hangar-upgrade-row` behind. Scrolling the row first makes the identical tap work.

**[BUG] 3 — Results overlay NEXT often fails to open the scoreboard.** Duel: 1 tap, never reached (`013` is pixel-identical to `012`). 2v2 run 1: **3 taps, never reached** (`154`). 2v2 run 2: 1 tap, reached (`227`). Intermittent. `ResultsOverlay` binds `pointerdown` on its root to skip the MVP count-up and `click` on the button — a tap that does both is the likely culprit.

**[UX] 4 — The in-match pause screen opens above its own exits.** `866`: settings opens at DISPLAY/GRAPHICS; **"Resume match" and "Quit to main menu" are below the 412 px fold**, needing an unadvertised scroll. A tap at the button's reported position does nothing.

**[UX] 5 — The Register form's submit button is below the fold.** `904`: REGISTER sits at y=425 in a 412 px viewport. The overlay scrolls (532 vs 412) but nothing says so. Log In is fine (one fewer field). This is a new player's first screen.

**[VISUAL] 6 — Boundary proximity floods the whole screen flat pink.** `148-tdm-a-boundary-wall.png`: the entire viewport including HUD text is washed pink, no wall geometry visible, hull draining at 5%. From further out the wall does read as a gold hex surface (`h149`). **This is the closest thing to a "red bubble" anywhere in the build.**

**[VISUAL] 7 — The deflector bubble is a hex-panel sphere, but nearly opaque, and sometimes absent.** Correct faceted hex shape in `v056` / `h064`, but so saturated it hides your own hull and everything behind it. Inconsistent: `h023` has the sim reporting the shield **active at 93%** with **no bubble drawn at all**.

**[VISUAL] 8 — Death explosions white out the screen; the shockwave is a flat opaque band.** `h063`, `h066`, `v046`: a full-screen orange fireball that swamps the HUD. `h026…crop`: the shockwave is a hard-edged, low-poly, opaque orange-red bar with no falloff.

**[OK] 9 — Kinetic hits shower sparks at the impact point, no red bubble.** `c004…crop-520_320.png`: gold spark burst on the struck wing panel. Tracer rounds are flat yellow quads — readable, very low-fi at close zoom.

**[OK] 10 — Energy hits flicker the struck hull pale blue.** `v060`: the enemy cyan beam on A's hull washes the whole hull pale cyan with a red damage number. Working as described.

**[OK] 11 — Missiles explode at impact.** `h110`: yellow-white spherical burst, orange debris shards, red `122` readout at the impact point.

**[FUNCTIONALITY] 12 — Audio, measured by wrapping `AudioManager`** (`logs/audio-cues.json`). Autocannon held 6 s → **25 discrete `play("kinetic_fire", 0.75)` one-shots spaced ~60–70 ms** (t = 8387, 8446, 8512, 8598, 8658, 8729…) — one one-shot per round at ~15 rounds/s. `playLoop` was **never called** by any weapon, and `loops.size` was 0 after every release (nothing stuck on). **The sustained beam is UNVERIFIED** — blocked by #2. **No audio errors in any of the 24 console logs**; `[Audio] audio context created {master: 0.8, sfx: 0.8, music: 0.5}` on all 27 boots.

**[UX] 13 — Steering spams a browser intervention error.** **414 occurrences** of `Ignored attempt to cancel a touchmove event with cancelable=false…` — `preventDefault()` on a non-cancelable `touchmove` on essentially every steering frame. Steering itself is fine (`steercheck.mjs`: heading 0.345 → −3.083 over a 3 s drag; canvas correctly has `touch-action: none`), but it will bury real errors. 20–55 per match on A, 31–159 on B.

**[BUG] 14 — A boot-time error on every client.** 26× `[Client] black-canvas verdict before the policy was ready: stalled (render loop never ticked — 0 frames in 3.5s)`, at `error` level, on boots that then render perfectly.

**[FUNCTIONALITY] 15 — Two humans pair only within a ~10 s window.** With a 2.8 s gap both land in the **same `roomId` on opposite teams** (`47:t0:playtest-match-a, 48:t1:playtest-match-b, 49:t0:bot, 50:t1:bot`). Beyond `bots.backfillWaitMs` (10 000 ms) the first room backfills, `lock()`s, and the second player silently gets a brand-new room — both then report `playerId 47` and neither kill feed mentions the other human. **No signal is given to the player**; it just looks like your friend never showed.

**[OK] 16 — Netplay agreement between the two perspectives.** Same instant, consistent opposite verdicts: `224` DEFEAT on A / `225` VICTORY on B. Both kill feeds named both humans and the same bots; MVP and score matched. Paired mid-fight shots (`219`/`220`) show a consistent world. **No rubber-banding, no desync, no hangs, no disconnects in any match.** Only network error: `WebSocket is already in CLOSING or CLOSED state.` (4×), always at teardown after quitting.

**[UX] 17 — Your rewards sit under someone else's stats on the results screen.** `010` (A's screen): `DEFEAT · MVP · PLAYTEST-MATCH-B · 1 KILLS / 0 ASSISTS / 0 CAPTURES · +25 credits · +25 xp`. Name and stat tiles are the MVP's; the rewards line is yours. B's identical layout read `+110 · LEVEL UP! → LEVEL 2`. Nothing separates them.

**[VISUAL] 18 — Long MVP names wrap mid-word.** `118`: `VortexFall_99` renders as "VORTEXFALL_9" with a lone "9" on a second line.

**[FUNCTIONALITY] 19 — Performance at phone resolution.** **AUTO picks LOW** on this machine — the default player sees the 0.35× particle budget, not the effects as authored. Pinned HIGH, single client, 5v5: **15–25 fps**. Two clients on one GPU: 9–34 fps. Caveat: dev build, headed Playwright Chromium, 2402×1082 backing store — a relative signal, not a device benchmark.

**[OK] 20 — Confirmed working.** Throttle lever drag (0→100%, 54 m/s) · floating steer drag · weapon tap-and-hold · BOOST · JETTISON (goes `disabled` after use) · respawn (hull→120, `launchHold`, "RESPAWNING…") · vital arcs · lock ring (`LOCKED · 328m · PLAYTEST-MATCH-B`) · numbered module badges 01/02/03 + ammo badge `24` · speed readout · minimap `R 140` · score banner (`FIRST TO 10 · 9:40`, CTF `FIRST TO 3 · 6:54`) · kill feed incl. CTF objectives (`Zen1thHD took the red flag`) · boundary toast · quit-to-menu returning cleanly to the lobby.

**[UX] 21 — Duel says "FIRST TO 5" but ends on the first kill.** `duel-1v1` has `fragLimit 5` *and* `eliminationEndsMatch: true` with `respawn.enabled: false`. The banner reads `0 FIRST TO 5 0` (`008`) then jumps to `0 MATCH OVER 1` (`009`) — it promises a race that cannot happen.

## Counts by category
**[BUG] 4** (1, 2, 3, 14) · **[UX] 6** (4, 5, 13, 15\*, 17, 21) · **[VISUAL] 4** (6, 7, 8, 18) · **[FUNCTIONALITY] 3** (12, 15, 19) · **[OK] 5** (9, 10, 11, 16, 20). *(\*#15 spans two categories.)*

## Could not test
1. **Sustained beam loop audio** — blocked by #2 (three scripted fit attempts, both hardpoints, all failed). 2. **Shield assemble / chaotic shatter beats** — confirmed the hex sphere and its active/absent states, but at 15–25 fps the transition frames fall between screenshots; `__debug.forceFrame` deliberately avoided because it would falsify online timing. 3. **CTF boundary wall** — Lunar Rift is far larger (reached radius 350 with no warning inside budget); boundary evidence is from Ring Nebula. 4. **Carrying a flag / scoring a capture** — bots took flags, this pilot never reached a stand; capture HUD undocumented. 5. **Audio by ear** — only mixer call patterns. 6. **>2 humans** — only two accounts existed, so all larger modes were bot-backfilled. 7. **Real device / real network** — all `localhost`, so #16 means "no desync at ~0 ms RTT", not a verdict under jitter.

Rig scripts (run from repo root, e.g. `node playtest/match/playmatch.mjs tdm`): `rig.mjs`, `pilot.mjs`, `playmatch.mjs`, `vfxrun.mjs`, `vfxhq.mjs`, `clickcheck.mjs`, `cardhit.mjs`, `beamfit.mjs`, `hangarcheck.mjs`, `audiocheck.mjs`, `roomcheck.mjs`, `steercheck.mjs`, `flightcheck.mjs`, `crop.mjs`, `sheet.mjs`. No game source file was modified; no server was started or stopped.
