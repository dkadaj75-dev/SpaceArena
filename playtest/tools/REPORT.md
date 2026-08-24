# Playtest — Tools Constellation (in-game designer suite)

**Folder:** `playtest/tools/` — 108 screenshots in `shots/`, 10 scripts (`lib.mjs`, `01-entry`, `02-probe`, `03-discover`, `10-world`, `11-ships`, `12-content`, `13-balance-system`, `14-scroll-probe`, `15-map-fixup`).

**Device:** Samsung phone LANDSCAPE 915×412, DPR 2.625, isMobile, hasTouch, Android Chrome UA. Auto-login as dev **Admin**.
**Renderer:** WebGL2 via ANGLE/SwiftShader. Verified painting early — lobby diorama, arena and ship previews all render (`01`, `08`, `30`). No black canvas anywhere.

**Non-destructive:** no `Save to disk`/`Save`/`Apply` ever pressed; nothing created, duplicated or deleted. One validation probe typed `-99999` into `notification.fire-blocked.durationMs`, was screenshotted, then **restored to `2200`**. All edits stayed in the in-memory ConfigService; nothing under `content/` was written.

**Findings: 66** — 9 [BUG], 25 [UX], 3 [VISUAL], 1 [FUNCTIONALITY], 28 [OK].

## Headline

The shell's phone layout is written and shipped, but **it never runs on a phone in landscape.** The mobile bottom-sheet block at `client/src/editor/editor.css:1420` is gated on `@media (max-width: 720px)`; a landscape phone is **915 px wide**. Measured in-page: `matchMedia("(max-width: 720px)").matches === false`. The designer — who authors from a phone, the stated reason the Settings entry exists — gets the **desktop** layout: a 400 px right-docked column on a 412 px-tall screen, leaving **161 px** for form content.

## 1. Entry — Settings ▸ Constellation Designer
Lobby ⚙ `[data-lobby-settings]` (40×44) → bottom of Settings → **Constellation Designer** `[data-settings-designer]` (320×40) → shell opens. Shots `02`, `03`, `04`.

1. **[OK]** The no-keyboard path works first time, every run. F10 fallback never needed.
2. **[UX]** Button sits at the very bottom of a long Settings scroll, *below* the primary `BACK`, with no icon or "developer" framing — nothing distinguishes a whole authoring suite from a display toggle.
3. **[UX]** It calls `EditorShell.toggle()`; a second tap closes the shell, but the label never changes. (This bit the harness — a double-click silently closed it.)

## 2. EditorShell — chrome, navigation, sheet
Shots `05`, `06`, `07`, `94`.

4. **[BUG] Phone bottom-sheet layout never activates in landscape.** 720 px query vs 915 px viewport. Result: `grid-template-columns: 515px 400px`, and `.ed-brand` "CONSTELLATION" is not hidden, costing 133 px of top bar.
5. **[BUG] The drag/tap sheet handle is dead.** `.ed-sheet-handle` computes `display: none`, rect `0×0`. Tapping it *does* cycle `data-sheet` (half→full→collapsed→half) but inspector height stays **311 px in all three** — every `[data-sheet=…]` rule lives inside the same media block. Shots `05`/`06`/`07` are pixel-identical. **No way to expand or collapse the inspector on a landscape phone.**
6. **[UX] Chrome eats 61 % of the screen.** Measured on Map: 412 screen − 44 topbar − 57 toolrow − 36 inspector head − 115 panel sticky toolbar = **161 px (39 %)** of form.
7. **[UX] Scroll depth is brutal.** Body is 276 px. Content: Modules 1826, Map 1771, Modes 1317, Bots 1219, Inspector 1193, Theme 1069, Assets 1047, Balance 774, Notifications 647, Ships 591, Actions 570, Skins 474, Quality 310, Console 280, Tuning 276. Modules is 6.6 screens with no section index.
8. **[UX] Scroll position is shared across tools and never reset.** Leaving Map at 600 px and opening Inspector/Bots/Theme drops you at 600 px into the new form. Verified in `14-scroll-probe.mjs`. Scrolling itself is healthy (wheel reaches 1495 px and stays — `95`/`96`).
9. **[UX] `Save to disk` sits flush against `Exit`.** Right side: Save (106×44, primary cyan), OK status (56×44), Exit (49×44, danger red), ~6 px apart at the screen edge — where a right thumb lands. Exit is the narrowest button in the shell.
10. **[UX] Save is triplicated.** Every panel renders its own `Save to disk` *plus* the always-visible top-bar one, both identical primary-cyan, both on screen at once (`56`, `77`). Map adds a third labelled just `Save` (`08`).
11. **[OK] Nav hit targets are correct.** Every category and tool tab is **44 px tall**; tool row never overflows (widest: System at exactly 915 px). Socket rows 255×44.
12. **[OK] Dirty + validation status works well.** Invalid value lit badge `OK`→`2`, title *"2 validation problem(s) — click to open Problems"*, `2 unsaved` in top bar (`53`, `56`). Strongest piece of the shell.
13. **[BUG] One invalid field produced two identical Problems entries** — *"notification.fire-blocked durationMs: Too small: expected number to be >0"* listed **twice verbatim**, badge `2` (`54`).
14. **[VISUAL] Content slides under sticky headers unmasked** — rows sliced mid-glyph with no fade: Bots shows a half-height `ENGAGE — WEIGHT 1` (`56`), Theme a half-cut colour row (`78`).

## 3. World ▸ Map
Shots `08`, `95`–`108`.

15. **[FUNCTIONALITY] Core map operations are keyboard-only.** The panel's own help line: *"Ctrl+D duplicate · Delete remove · F frame · select 2 nav nodes + L link"* (`99`, `102`). Duplicate, remove, frame and nav-link have **no touch equivalent**. On the device this editor exists to serve, Map is a viewer with dropdowns. Biggest phone blocker in the suite.
16. **[UX] 13×13 px checkboxes** — layer Eye/Lock (4 layers × 2) and Mirror mode / Translate snap / Rotate snap, versus 44 px everywhere else (`98`, `102`).
17. **[UX] Asset palette labels unreadable** — 76 px buttons carrying `CTF Hangar Bay · structure · 9`, `Lunar Rift He-3 Extraction Pla…`. 25 props + 6 asteroids, indistinguishable (`100`, `101`).
18. **[UX] 46 placements render as 46 full inline transform forms** — 550 inputs, 134 `<details>`, no search or collapse-all.
19. **[OK] The sticky toolbar is the right idea** (arena, gamemode, Playtest, Game view stay pinned — `95`) but at 115 px it is 42 % of the body.
20. **[OK] Arena switching works** — Parker Point → Lunar Rift re-staged the scene (`108`).

## 4. World ▸ Inspector
21. **[OK]** Opens and signposts *"Showing Parker Point… Switch arenas in World ▸ Map."*
22. **[UX] Duplicates Map's schema form** — 533 of Map's 550 inputs. Two tools showing the same 1200 px form is a tab wasted. Shots `14`, `15`.

## 5. Ships ▸ Ships (ShipManager + ShipManagerModules)
Shots `16`–`31`. `ShipManagerModules` decorates `ShipManager` — the `"Ships"` re-registration in `main.ts:2093` is deliberate, the full socket editor is intact.

23. **[BUG] 3D socket markers unusable — all 12 labels pile on one another.** In the 515×311 cell the Interceptor renders ~150 px across; twelve labels stack into an overlapping block covering the ship (`30`). Markers cannot be told apart, let alone dragged. Same on all four hulls (`27`–`29`).
24. **[UX] The selected-socket popover covers what it edits.** A ~650 px card opens *over* the viewport (`21`) with pos x/y/z and `Duplicate`/`Frame`/**`Delete`**. Wider than the 515 px cell, semi-transparent so socket labels bleed through the numeric fields, `Delete` beside `Frame`.
25. **[OK] The socket *list* is excellent on touch** — 12 rows at 255×44 prefixed ◆ hardpoint / ◇ internal / ✦ emitter (`19`). This should be the primary path.
26. **[OK] Per-ship preview and fitted-modules toggle work** across all four hulls (`27`–`29`, `31`).
27. **[VISUAL] EditorStage grid degenerates into flat horizontal cyan scanlines** at this aspect ratio (`21`, `30`).
28. **[UX]** 264 inputs, 90 `<details>`, 44 list rows, 68 selects.
29. **[BUG] Placeholder geometry for every internal module** — `unknown render recipe "procedural.module.{engine,generator,hull,countermeasure,sensors}"`, all five repeating on every re-sync. Fitted-module preview shows grey boxes, not hardware.

## 6. Ships ▸ Skins
30. **[OK] Most phone-ready of the 3D editors** — 474 px, 5 sections, 36 inputs, ~2 screens.
31. **[OK]** Blue → Tiger → Zebra re-paints the preview immediately (`35`, `36`).

## 7. Ships ▸ Modules
32. **[UX] Tallest panel in the suite — 1826 px in a 276 px viewport (6.6 screens).** 21 sections, 82 inputs, a 58-entry dropdown as the only record navigation.
33. **[OK]** Schema regenerates per module kind (weapon → shield, `41`/`42`).

## 8. Content ▸ Assets
34. **[OK]** Six asteroids, 15 sections, 71 inputs; structure clear (shape/collision/render/spin/surface).
35. **[UX]** 3.8 screens; the `shape` sub-tree where authoring happens is ~2 screens down. Shots `43`–`47`.

## 9. Content ▸ Actions
36. **[OK] Genuinely phone-usable** — 570 px, 6 inputs, 2 selects.
37. **[OK] The `kind` select drives the form** — `apply_damage` → `spawn_entity` regenerated fields correctly (`50`). Kinds: apply_damage, spawn_entity, apply_buff, impulse, play_sound, show_notification, change_asset_state, grant_reward.

## 10. Content ▸ Notifications
38. **[OK] Smallest, cleanest editor** — 647 px, 8 inputs (text, style, durationMs, triggerEvent).
39. **[OK] Validation probe well-surfaced** — badge `2`, `2 unsaved`, Problems reporting *"Too small: expected number to be >0"* (`53`, `54`).
40. **[UX] The invalid field gets no inline treatment** — no red border, no message beside the input. Only signal is a top-bar badge and a panel two taps away.

## 11. Content ▸ Bots
41. **[OK] Best-designed form in the suite** — behaviours as weighted accordion rows (`objective — 0.75`, `engage — 1`, `kite — 1.1`, `avoidRocks — 0`) with `Add behavior…`. Domain-shaped, not schema-shaped.
42. **[OK]** Five profiles; `Add param…` reports `All params set` when exhausted.
43. **[UX]** 23 small `×` removal buttons; 141 controls in 1219 px. Shots `55`–`60`, `97`.

## 12. Content ▸ Modes
44. **[OK]** Seven modes, 10 sections, 68 controls; `shipPool`/`arenaPool` resolve real config ids (`65`).
45. **[UX]** 4.8 screens; `rewards` is the full form height from the record selector.

## 13. Balance ▸ Tuning
46. **[OK] The only panel that fits the screen** — 276 px content in a 276 px viewport, zero scrolling at rest.
47. **[OK] The `FIND FIELD` filter is the right answer to deep forms** (placeholder *"e.g. damage, netRenderDelayMs"*; typing `camera` filtered live — `67`). **It exists in exactly one panel**; Modules (1826 px) and Theme (1401 controls) need it far more.

## 14. Balance ▸ Balance Workbench
48. **[BUG] Horizontal overflow — the only panel that breaks its column.** Body `scrollWidth 778` vs `clientWidth 400`; inner `.editor-panel` `764 > 372`. **Half of every table is off-screen.** Stat comparison clips `ENERG…`, losing ENERGY TANKS, RECHARGE (X), BURST DPS, SUSTAINED DPS, SHIELD (`71`). TTK matrix headers clip to `INTERCEPTO`, `STARPIERCE`, `TAL` (`70`, `73`).
49. **[UX] No frozen first column.** Scrolling right takes the ship names with it — `72` shows five rows of bare numbers with **nothing identifying which hull each row is**. The comparison tool cannot be read on this screen.
50. **[OK] The simulator renders** — 60 s engagement chart on a 342×142 canvas (`75`); switching custom fit to Brawler recomputed the table (`76`).
51. **[UX] Nothing signals the horizontal axis** — no scrollbar, shadow or chevron; clipped columns look like the end of the table.

## 15. System ▸ Theme
52. **[UX] Heaviest panel by control count — 1401 controls, 90 sections, 1069 px.** Colours, fonts, tokens, typography, radii, the entire HUD **three times** (base / portrait / landscape overrides), haptics, audio, screens, juice, menu backdrop, scene, matchmaking flavour lines. One flat scroll, no search.
53. **[VISUAL] Text fields overflow internally** — several `.ed-input` hold 323 px of content in a 192 px box (also 221>201); token/path values truncated with no wrap or title (`77`).
54. **[OK] Colour editing is well-formed** — 34×40 swatch + editable hex + `×`, plus `Add color` (`78`).
55. **[UX] Only one theme exists** (a 1-option select), yet the selector, `New theme` and a panel `Save to disk` occupy ~135 px of the 276 px body. Shots `79`–`83`.

## 16. System ▸ Quality
56. **[OK] Phone-usable by construction** — 310 px at rest: four collapsed tier accordions; 220 inputs stay hidden until a tier opens. **This is the pattern the other editors need.**
57. **[UX] Four separate `Save to disk` buttons**, one per tier, plus the top bar's. Shots `84`–`87`.

## 17. System ▸ Console
58. **[OK] The most phone-adapted tool in the suite.** One input, a scrolling transcript, no chrome. All commands worked: `help`; `ls ship` → brawler/interceptor/support/talon; `get ship.interceptor core` → full JSON (`91`); `bogus` → *"Unknown command: bogus. Try `help`."* (`92`).
59. **[UX] History is `Up / Down arrows` only** — stated in the help text, unreachable on a phone. No on-screen recall or autocomplete for the long dotted paths it asks you to type (`core.recharge.multiplier`).
60. **[OK]** `set` exists but was deliberately not exercised.

## 18. System ▸ Problems
61. **[OK]** *"No current validation problems."* when clean; `type.id field: message` when not; one tap from the status badge.
62. **[UX]** Entries are plain text — no jump from a problem to the field that caused it.

## 19. Console output across all runs
63. **[BUG]** `[HotReload] ✖ invalid JSON in themes/default.json: SyntaxError: Unexpected end of JSON input` — watcher reads the file mid-write and reports a parse failure as an error rather than retrying.
64. **[BUG]** `[Client] black-canvas verdict before the policy was ready: stalled (render loop never ticked — 0 frames in 3s)` — logged as an **error** on every boot while rendering demonstrably works. False positive on software GPUs.
65. **[BUG]** `[AssetRegistry] unknown render recipe "procedural.module.*"` ×5, repeating on every re-sync (see 29).
66. **[OK]** No uncaught `pageerror` in any run. No DOM exceptions. The editors are functionally sound.

## Inventory

| # | Editor / Panel | Group | Reachable | Phone-usable @915×412 | Content px | Shots |
|---|---|---|---|---|---|---|
| 1 | **MapEditor** | World | Yes | **No** — edit ops keyboard-only (15); 13 px toggles | 1771 | `08`, `95`–`108` |
| 2 | **Inspector** (arenaInspector) | World | Yes | Partial — duplicates Map | 1193 | `14`, `15` |
| 3 | **ShipManager** (+ModulesDecorator) | Ships | Yes | Partial — list yes, 3D markers **no** (23, 24) | 591 | `16`–`31` |
| 4 | **SkinEditor** | Ships | Yes | **Yes** | 474 | `32`–`36` |
| 5 | **ModuleEditor** | Ships | Yes | Partial — 6.6 screens, no search | 1826 | `37`–`42` |
| 6 | **AssetEditor** | Content | Yes | Partial — 3.8 screens | 1047 | `43`–`47` |
| 7 | **ActionEditor** | Content | Yes | **Yes** | 570 | `48`–`50` |
| 8 | **NotificationEditor** | Content | Yes | **Yes** | 647 | `51`–`54` |
| 9 | **BotProfileEditor** | Content | Yes | Partial — good structure, 141 controls | 1219 | `55`–`60`, `97` |
| 10 | **GamemodeEditor** | Content | Yes | Partial — 4.8 screens | 1317 | `61`–`65` |
| 11 | **TuningPanel** | Balance | Yes | **Yes** — fits exactly; has field search | 276 | `66`–`69` |
| 12 | **BalanceWorkbench** | Balance | Yes | **No** — 778 px in a 400 px column (48, 49) | 774 | `70`–`76` |
| 13 | **ThemeEditor** | System | Yes | **No** — 1401 controls, no search | 1069 | `77`–`83` |
| 14 | **QualityEditor** | System | Yes | **Yes** — accordion-per-tier | 310 | `84`–`87` |
| 15 | **ConsolePanel** | System | Yes | **Yes** — except arrow-key history | 280 | `88`–`92` |
| 16 | **Problems** | System | Yes | **Yes** | 276 | `93`, `54` |
| — | **EditorShell** (chrome) | — | Yes | **No** — sheet inactive, handle dead (4, 5) | — | `04`–`07`, `94` |

**Reachable: 16/16. Nothing failed to open; no panel threw.** Also exercised: **SchemaFormGen** (drives generated forms in 11 panels — `<details>` trees, `New…`/`Remove` rows, `x present` toggles, reference selects) and **saveConfig** (the `Save to disk` surface, deliberately never pressed).

**Phone verdict**
- **Usable now (6):** Skins, Actions, Notifications, Tuning, Quality, Console/Problems
- **Usable but punishing (6):** Inspector, Ships, Modules, Assets, Bots, Modes — correct, just too tall for a 276 px window
- **Hopeless without redesign (3):** **Map** (keyboard-only editing), **Balance Workbench** (half the table off-screen, no row labels), **Theme** (1401 controls in one flat scroll)

**Four highest-leverage changes**
1. **Change the media query** from `max-width: 720px` to orientation/height/pointer-aware (`(max-height: 500px)` or `(pointer: coarse)`) so the bottom sheet, hidden brand, and working `data-sheet` states actually apply. Findings 4, 5, 6 collapse into this one fix.
2. **Give Map touch equivalents** for Ctrl+D / Delete / F / L (15) and raise the 13 px toggles to 44 px (16).
3. **Adopt Quality's accordion-per-record and Tuning's field search everywhere** (7, 32, 45, 52) — both patterns already exist in this codebase and already work.
4. **Make Balance's tables scroll with a frozen first column**, or reflow to stacked cards (48, 49).

## Not covered, and why
- **`Save to disk`/`Save`/`Apply` on every panel** — deliberately not pressed (writes to `content/`).
- **`New…`/`Duplicate`/`Remove`/`Del` on every record list** — deliberately not pressed (creates/destroys content).
- **`New prop (import GLB…)`** — opens a file picker and uploads a model; out of scope for a non-destructive pass.
- **`Playtest` / `Game view (G)`** — starts a live match; would leave the editor and disturb the shared game server other agents are on.
- **Console `set`** — mutates config; only `help`, `ls`, `get` and an unknown-command probe were run.
- **Dragging a 3D socket marker** — the markers overlap into a single unpickable cluster at this size (finding 23), so a drag could not be aimed at a specific marker, and a successful drag would move a socket. The `pos x/y/z` fields were opened and read instead (`21`).
