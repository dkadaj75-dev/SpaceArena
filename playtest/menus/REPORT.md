# Playtest — MENUS agent

**Summary: 68 findings — 12 [BUG], 4 [FUNCTIONALITY], 27 [UX], 10 [VISUAL], 15 [OK]. 136 screenshots in `playtest/menus/shots/`** (scripts `01-auth.mjs`…`16-final-checks.mjs`, `lib.mjs`, `probe.mjs`, `diag-*.mjs`).

**Device profile:** 915 × 412 CSS px landscape, DPR 2.625, `isMobile`, `hasTouch`, Android Chrome UA. Every shot is a viewport capture at those proportions (2402 × 1082 files).
**Identity:** registered a fresh online account **`playtest-menus`** through the auth screen at `/?login=1` (Lv 1, 250 cr). The lobby's counter did include it (`3 pilots online` / `4 pilots online` across runs).

## Harness notes

**Headless Chromium cannot boot this game on this machine.** With `--use-angle=swiftshader --enable-unsafe-swiftshader` the engine comes up (Babylon 8.56.2, WebGL2, SwiftShader) but the render loop never ticks, so: the guard logs `stalled (render loop never ticked — 0 frames in 3.5s)`; `await warmingDiorama.ready()` in `main.ts` never resolves so the boot curtain never lifts and the auth screen stays `display:none` forever; and the 3.5 s health probe times out against a healthy server, dropping the client into offline mode.

**Headful alone was not enough either** — with a real GPU (ANGLE / Intel UHD 630 / D3D11) the loop still never ticked, because Windows reports the automated window as occluded and Chrome throttles rAF to zero. Working recipe: headful **plus** `--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`. Anything that drives this game in CI will hit the same wall: the boot gate is hard-blocked on a drawn frame.

Two tooling artefacts that are *not* product bugs: Playwright's `hover()`/`click()` time out on `.hangar-card.unavailable` and on an already-equipped `.shop-equip-btn` because those are genuinely `disabled`; and `mouse.move` does not raise the hangar hover preview under touch emulation (the app correctly serves press-and-hold instead — finding 37).

## Findings

### Boot / launch

1. **[UX] The fullscreen dialog interrupts the launch sequence.** It appears ~1 s in, on top of the still-fading "SEPTENTRION GAMES" publisher card; the title card only gets its beat *after* the dialog is answered. The brand moment is spent behind a modal. `001`, `002`, `003`.
2. **[UX] The fullscreen prompt is asked on every boot** — "Not now" is not remembered (7+ relaunches, shown every time). `002`, `119`.
3. **[OK] Boot stage marks and the outcome note work well.** The offline boot holds "SERVER OFFLINE — playing locally against bots" before the lobby repeats it as a badge. `120`.

### Auth screen

4. **[BUG] The expanded auth panel overflows the landscape viewport.** With the login form open the "LOG IN" submit is cut by the bottom edge and "Skip (offline practice)" is off-screen entirely. It does scroll, but scrolling pushes the wordmark and "Play as Guest" out of view — you never see the whole gate at once. `005`, `006`, `012`.
5. **[UX] Errors render above the form, not next to the field** — between "Play as Guest" and the toggle link, and on the register tab they can scroll off while you type. `006`, `008`, `010`, `012`.
6. **[UX] Raw server validation text reaches the player:** `password: Too small: expected string to have >=8 characters`, while the empty-nickname case gets friendly copy ("Choose a nickname"). `012`.
7. **[VISUAL] The gate is a ~340 px column centred in 915 px.** Two thirds of the landscape width is empty while the form scrolls vertically. `004`–`013`.
8. **[OK] The flows are correct** — client validation, 401 bad-credentials, 400 password-length, and registration → lobby all behaved. `006`–`014`.

### Lobby

9. **[BUG] Legibility of everything drawn over the diorama.** Blue title, grey subtitle, the "N PILOTS ONLINE" line and — worst — the drawer heading sit over a blown-out orange sunburst. "TEAM DEATHMATCH" as a heading is very nearly invisible. `014`, `017`, `121`.
10. **[UX] Bottom-heavy layout.** The top ~55 % of a 412 px screen is empty diorama; every control is crammed into the bottom 45 %, two rows deep with the second row nearly touching the edge. `015`, `019`.
11. **[UX] Touch targets, measured:** mode/destination cards 58 px tall (fine), "Log out" 71 × 44 (fine), settings gear **40 × 44** — the smallest interactive thing on screen and the one furthest into a corner. `015`.
12. **[FUNCTIONALITY] "Skip (offline practice)" produces a lobby where nothing is playable.** With the server *reachable*, skipping leaves you unauthenticated: all four mode cards come back `disabled` — but render **identically to enabled cards** (same fill, border, text colour), the only explanation hidden in a `title` tooltip a phone cannot show. The link's own promise is not honoured. `117`.
13. **[BUG] Contradictory status in one header:** the chip says "Playing offline" while the line under the title says "3 PILOTS ONLINE". `117`.
14. **[VISUAL] The SERVER OFFLINE badge is half-unreadable** — "(could not be reached)" is dark grey over the sunburst, and the badge has a stray notch hanging outside its panel on the left. `121`.
15. **[OK] True offline mode is handled well** — badge visible, every mode enabled with a per-card explanation, Hangar fully functional locally. `121`, `122`, `123`.
16. **[UX] The Deathmatch group contains exactly one mode ("Duel")**, CTF likewise — a drawer that costs a tap to reveal one card. `016`, `018`.
17. **[OK] The drawer pattern reads well** — heading, cards, a distinctly smaller "← BACK" chip. `017`.

### Settings

18. **[UX] 1916 px of settings in a 412 px viewport** (measured) — ~4.6 screens of scroll through 7 groups, in a single ~470 px column, landscape width unused. Two columns would halve it. `021`–`028`.
19. **[UX] No persistent way out.** "BACK" is at the very bottom, after all seven groups. `033`.
20. **[VISUAL] The sliders are unstyled native `input[type=range]`** — white track, default blue circular thumb — the only browser-default controls in a fully custom-themed app. `026`, `027`.
21. **[VISUAL] An "ON" toggle is a full-width solid blue slab**, identical in weight to a primary CTA, so "Camera shake ON" competes with "BACK". `026`.
22. **[UX] "Constellation Designer" (a developer tool) is offered in the player settings sheet**, both from the menu and inside a match. `033`, `134`.
23. **[OK] The content is good** — Quality/Renderer segmented controls with honest notes ("WebGPU is experimental — it can present a black canvas on some GPUs"), read-only bindings list, reload/reset escape hatches. `023`, `028`.
24. **[OK] Changes apply live and stick** — haptics off→on, master volume 0.8→0.35→0.8 both logged and re-rendered instantly. `029`–`032`.
25. **[OK] The in-match variant swaps in the right actions** ("Resume match", "Quit to main menu"). `133`.

### Hangar

26. **[FUNCTIONALITY] The hangar does not open on your main hull.** BRAWLER carried "★ MAIN"; the hangar opened on INTERCEPTOR, three arrow-taps away. Across runs it opened on Talon, then Brawler, then Interceptor — it lands on whatever was browsed last. Once it opened on an *unowned* hull, so the fitting panel was empty on arrival. `058`, `042`; tour logged as `INTERCEPTOR(Set as main) → STARPIERCER(Set as main) → TALON(Buy) → BRAWLER(★ MAIN)`.
27. **[FUNCTIONALITY] The hull dots are not tappable.** `.hangar-ship-dots` computes `pointer-events: none` and `elementFromPoint` at a dot's centre returns the render canvas — every tap falls through to the 3D view. They are also **22 × 4 px** each. Stepping hulls is arrows-only. `035`, `058`.
28. **[VISUAL] The dots and the hull readout collide** — "INTERCEPTOR LIGHT HULL" (x 16, y 387) and the dot row (x 207, y 392) share a 13 px band over the darkest part of the bay floor. `035`, `058`.
29. **[BUG] Slot-tile text clips and overflows.** Labels ellipsise to "Earth Engi…", "Earth Gen…", "Common S…", and the socket sub-label renders as **"UNTERMEASU"** — COUNTERMEASURE overflowing its 66 px tile on both sides. `035`, `050`, `058`.
30. **[UX] An unowned hull is a blank screen** — no slots, skins or upgrades, one sentence in an empty right half, and the model renders almost black so you cannot see what you'd be buying. `040`, `044`.
31. **[VISUAL] The "LOCKED" badge overlaps the "BUY · FREE" button's top-right corner.** `040`.
32. **[UX] A ~200 px dead zone sits mid-panel** between the CORE/INTERNAL tiles and SHIP SPECS, while the skin row is squeezed into the last 18 px at the bottom. `035`, `050`, `058`.
33. **[BUG] Skin swatches are 18 × 18 px** — nine of them in a 363 px row pinned to the very bottom edge, with no visible label (only a `title`: "Blue · FREE"). Less than half a comfortable touch target. `035`, `050`, `051`.
34. **[UX] Upgrade buttons are 45 × 24 px** — three on one line with labels. Also under-size. `054`.
35. **[UX] "0 cr" upgrade buttons read as broken data.** All three tracks show "0 cr" until you buy one, at which point the row becomes "Hull 200 cr". `054`, `055`.
36. **[UX] "SHIP SPECS — BEFORE / AFTER" reads as a delta but is not one.** `DPS 3.2 ▲ 117.2` means "3.2 now, 117.2 if you keep this", not "+117.2"; with a down arrow (`POWER 5 / 10 ▼ 2 / 10`) it is more misleading still. The numbers are right, the notation is the problem. `082`, `131`, `132`.
37. **[UX] The preview interaction is undiscoverable on a phone.** No hover on touch, so the compare readout only fills in after a **260 ms press-and-hold**, and nothing says so. A player who taps normally commits the fit and never sees the comparison the panel exists for. `081` (idle) vs `082` (held).
38. **[UX] Unavailable module cards give no reason** — "Nanite Repair Field Mk I", "Tether Ray Mk I", "Autocannon Mk II" render greyed with no badge, price, `title`, or "requires level N". `050`, `061`.
39. **[UX] The module sheet covers the ship it is previewing.** The card deck fills the lower-left quadrant and CLEAR SLOT / DONE ✓ float over the hull — the 3D model is obscured exactly while you fit it. `050`, `063`.
40. **[OK] The fitting mechanics all work** — buy a free hull → 9 slots and 9 skins appear; ★ Set as main; tap-to-fit; CLEAR SLOT empties the tile to "+ EMPTY / HP-WING L"; power budget and pip bar update live. `045`–`047`, `063`, `064`.
41. **[OK] The hardpoint/core split, socket labels and MAIN star badge are a clear information model** once the clipping in 29 is fixed. `050`, `058`.

### Shop

42. **[BUG] A raw developer diagnostic covers the shop header for the whole visit.** A red panel reading `3D DISPLAY FAILED — no-active-meshes / build 7745ef2-mt6edo69 … cvs 1031x464 dpr 2.625 hs 0.89 | f 0 fps 122 | mesh 5/0 | hit=div.shop-card-head | guard fired:no-active-meshes` sits over the title, credits and Close. It is a **false positive**: the shop legitimately hides the diorama, so the guard sees 0 active meshes and fires. `071`, `073`, `074`.
43. **[BUG] Level gating is invisible until the server refuses.** With 250 cr I could tap "Buy · 1500 cr" on the Chaff Pod; the button is fully enabled and the only feedback is a 403 rendered as "⚠ Purchase failed — module requires level 3 (you are level 1)". `071`, `073`.
44. **[BUG] The number on the card is not the number enforced.** The card reads "COUNTERMEASURE · **LV 2**"; the refusal says "requires level **3**". Whatever "LV 2" means, it is not the requirement — and it is the only number the player has. `071`, `073`.
45. **[FUNCTIONALITY] There is no affordability state at all.** Every Buy button in the modules tab is enabled regardless of the 250 cr balance (measured: zero disabled buy buttons among 58 cards). There is no "can't afford" styling to screenshot because none exists.
46. **[UX] The lists are enormous with no search or filter.** Modules: 58 cards / 5082 px ≈ 12 screens. Paints: 36 cards / 3044 px ≈ 7 screens. Group headings are the only navigation. `071`, `072`, `074`.
47. **[UX] Paint cards are ~440 px tall each** — giant swatch, name, "FITS BRAWLER", "EQUIP ON", two buttons. Three fit on screen. `074`.
48. **[UX] Shop tabs are 140 × 40 px** — under the 44 px minimum, and they are the screen's primary navigation. `069`.
49. **[UX] The header eats ~45 % of the first screen** (Close chip, credits, "Shop", "REQUISITION", rule, tabs) before one item is visible. `069`.
50. **[OK] Buying works cleanly** — a free hull flipped from "Buy · FREE" to the "OWNED" badge, credits correctly unchanged, no reload. `069`, `070`.
51. **[OK] The ships tab is the best-designed grid in the game** — stat chips (HULL/SPEED/TURN/POWER), hull class, price, one clear action. `067`, `069`.

### Tutorial

52. **[BUG] The coach card renders on top of the match loading panel.** "PREPARING ARENA / The Ring / Loading arena assets — 90 %" is unreadable behind it and the progress bar is half-covered. Two modal layers with no z-order relationship. `086`.
53. **[BUG] The coach card also renders on top of the in-match Settings sheet** — "Resume match" and "Quit to main menu" end up behind it; "…E MATCH" is all you can read of the primary action. `134`, `133`.
54. **[UX] The coach card is dead-centre and covers the player's own ship** (520 × 178 px at x 198, y 142 in a 915 × 412 viewport). Every instruction hides the thing being instructed. `087`, `127`.
55. **[UX] Step 1's hint points at a control that is not on screen yet.** "Drag the throttle on the right" is shown during the countdown, when the throttle strip has a 0 × 0 box; it only appears once the countdown clears. `087` (absent) vs `103` / `124` (present).
56. **[VISUAL] "SKIP TUTORIAL" is low-contrast grey** inside a large tappable card. `087`, `127`.
57. **[OK] The coach content is genuinely good** — instructor badge, "Step N / 11", title, a line of flavour, a separate mechanical hint. `124` (THROTTLE), `125` (STEERING), `127` (GUNS), `126` (ENERGY).
58. **[OK] Skip exits cleanly to the lobby** with no residue. `093`, `130`.
59. **[BUG] Mid-session the tutorial stopped starting at all**, hanging forever on "PREPARING ARENA / Building flight school" with only "Cancel". Console: `[Client] failed to start the tutorial match ReferenceError: Cannot access 'stagedArenaId' before initialization — at setArena (main.ts:265) ← prepareSessionArena ← startTutorialMatch`. The source still has that shape: `setArena` (line 463) writes `stagedArenaId`, `let`-declared at line 1995 of the same scope — a temporal-dead-zone hazard whenever `setArena` runs before the declaration. `main.ts` was being edited by someone else while I worked (its Vite `?t=` hash changed between runs), so this may be a transient mid-edit state — but the TDZ shape is still in the file, and **the player-facing failure is an infinite loading screen with no error message at all**. `106`, `107`.

### End-of-match results

60. **[OK] The results overlay is the strongest screen in the game** — clear DEFEAT status, MVP block, three stat tiles, a reward line, three 44 px buttons in a sensible hierarchy. `113`, `114`.
61. **[UX] Whose stats are these?** The tiles ("1 KILLS / 0 ASSISTS / 0 CAPTURES") sit directly under the MVP's name (`LILLUMEN_`) so they read as the MVP's, while "+25 credits · +25 xp" below is unambiguously yours. Two subjects share one column with no separator. `113`.
62. **[UX] "NEXT" is the primary button and says nothing.** The two buttons that describe real outcomes ("PLAY A NEW GAME", "QUIT TO MENU") are demoted to secondary. `113`.
63. **[VISUAL] The panel is right-anchored, leaving the left ~45 % empty** — the same "column of content, half the screen unused" pattern as everywhere else. `113`.
64. **[OK] "Quit to Menu" returns to a clean lobby.** `115`.

### Cross-screen consistency

65. **[VISUAL] Four different "get me out of here" idioms.** Hangar: "✕ BACK" outlined button top-right. Shop: "Close" chip top-right. Settings: full-width "BACK" primary at the bottom of a 1916 px scroll. Tutorial: "SKIP TUTORIAL" grey text link inside the card. Nothing is in the same place twice. `035`, `069`, `033`, `087`.
66. **[UX] Credits and identity appear and vanish.** Lobby shows `playtest-menus · Lv 1 · 250 cr`; shop shows credits only; hangar shows neither — despite billing upgrades in cr. `015`, `069`, `035`.
67. **[VISUAL] Two visual languages fight.** The 3D-backed screens (lobby, hangar) put small dark-blue UI over very bright 3D; the flat screens (settings, shop, auth) put the same UI over a calm dark starfield where it reads perfectly. Almost every legibility problem here is on a 3D-backed screen.
68. **[BUG] `black-canvas verdict … stalled (render loop never ticked — 0 frames in Ns)` is logged as an error on essentially every launch**, including launches that render fine a second later (`BlackGuard stood down after 3 clean probes` always follows). With finding 42, the guard is noisy enough that a real black-canvas event would be hard to spot.

## Coverage checklist

**Visited and screenshotted:** boot publisher card (001) · fullscreen prompt, online + offline boots (002, 119) · post-dismissal staging (003) · boot server-offline note (120) · auth collapsed (004, 116) · auth expanded Log In (005) · client validation errors (006, 010) · filled login (007) · server error (008) · Register tab empty (009) · short password + server error (011, 012) · register ready → lobby (013, 014) · auth reopened from lobby link (118) · lobby root authed (015, 019, 034, 041, 048, 057, 076, 094, 105, 115, 136) · Deathmatch drawer (016, 108) · Team Deathmatch drawer (017) · CTF drawer (018) · destination hover (020) · "Playing offline" chip / disabled modes (117) · SERVER OFFLINE badge + offline drawer (121, 122) · settings Display (021, 022), Graphics (023), Audio (024), Feedback (025), Camera (026), Controls (027), Renderer (028) · toggle round-trip (029–031) · slider change (032) · settings bottom actions (033) · settings from inside a match (133–135) · hangar Interceptor (035, 049, 058), Starpiercer/Talon/Brawler via arrows (036–038), prev arrow (039) · locked hull LOCKED + BUY·FREE (040, 044, 056) · after buying (045) · Set as main available/applied (046, 047) · module sheet hardpoint (050, 062, 081), internal + last slot (065, 066) · card selected (060, 084) · unavailable card (061) · CLEAR SLOT before/after (062, 063, 132) · refit + DONE (064, 131) · press-hold BEFORE/AFTER delta (082, 083) · skins (051–053) · upgrades before/after (043, 054, 055) · hangar offline (123) · shop Ships + scrolled (067, 068) · free purchase before/after (069, 070) · Modules + bottom (071, 072) · refused purchase (073) · Paints + equip row + bottom (074, 075, 077–080) · tutorial loading screen (086, 109, 110) · coach steps THROTTLE (087, 095, 124), STEERING (125), GUNS (127), ENERGY (126) · HUD context / before / after skip (091–093, 130) · hung tutorial regression (106, 107) · matchmaking + staging (109–111) · in-flight HUD, brief (112) · results overlay (113, 114).

**Not reached, and why:**
- **A confirm-only ("Got it") coach step** — all of the first four tutorial steps are condition-gated; the confirm button exists but is hidden on those.
- **Tutorial completion / completion toast** — needs all 11 steps including kills; that's combat, the *match* agent's remit.
- **An "unaffordable"/disabled Buy state** — does not exist (finding 45).
- **A priced or genuinely unbuyable hull** — all four hulls in this pack are FREE, so "locked" is always one tap from owned.
- **"Play as Guest" and the guest "Upgrade account" link** — taking the guest path would have created a second identity for this agent; per the brief I registered instead. Its sibling ("Log in / Sign up" from an unauthenticated lobby) *was* exercised (118).
- **The results overlay's "NEXT" page** — I quit to menu rather than hold an online room open.
- **The Constellation Designer** behind the settings button — a developer editor, not player UI.
- **Scoreboard, kill feed and the rest of the in-match HUD** — deliberately left to the match agent.
- **Portrait orientation** — out of scope per the brief.

## Account side effects

`playtest-menus` finished at Lv 1 / 250 cr owning **Interceptor, Talon and Brawler** (all free), with **Brawler set as main**, one free Hull upgrade tier purchased, a Brawler paint equipped, and the Interceptor's `hp-wing-l` hardpoint refitted with an Autocannon Mk I during the delta tests. One online Duel was played to completion (lost) to reach the results overlay; `+25 credits · +25 xp` were awarded there.
