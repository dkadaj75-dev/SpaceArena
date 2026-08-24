// Do two clients queueing the same online mode actually land in one room?
import { launchBrowser, openClient, dismissFullscreen, ensureAccount, sleep, tapEl, shot } from "./rig.mjs";

const gm = process.argv[2] ?? "gamemode.practice-bots";
const cat = process.argv[3] ?? "team deathmatch";
const gapMs = Number(process.argv[4] ?? 1500);

const browser = await launchBrowser();
const A = await openClient(browser, "roomcheck-a");
const B = await openClient(browser, "roomcheck-b");
await Promise.all([dismissFullscreen(A), dismissFullscreen(B)]);
await Promise.all([
  ensureAccount(A, "playtest-match-a", "playtest1234"),
  ensureAccount(B, "playtest-match-b", "playtest1234"),
]);

const queue = async (c) => {
  await tapEl(c, c.page.locator(`.sa-menu-category[data-lobby-action="${cat}"]`));
  await sleep(450);
  await tapEl(c, c.page.locator(`.sa-menu-card[data-gamemode="${gm}"]`));
};

const t0 = Date.now();
await queue(A);
console.log(`A queued at +${Date.now() - t0}ms`);
await sleep(gapMs);
await queue(B);
console.log(`B queued at +${Date.now() - t0}ms`);

const info = async (c) =>
  c.page.evaluate(() => {
    const s = window.__debug?.session;
    if (!s) return { ready: false };
    const room = s.net?.room;
    return {
      ready: true,
      roomId: room?.roomId ?? null,
      sessionId: room?.sessionId ?? null,
      playerId: s.playerId,
      names: (s.curSnapshot?.ships ?? []).map((sh) => `${sh.id}:t${sh.team}:${s.displayNameFor(sh.id) ?? "?"}${s.isBotFor(sh.id) ? "(bot)" : ""}`),
    };
  });

for (let i = 0; i < 40; i++) {
  const a = await info(A);
  const b = await info(B);
  if (a.ready && b.ready && a.roomId && b.roomId) {
    console.log("A:", JSON.stringify(a));
    console.log("B:", JSON.stringify(b));
    console.log(a.roomId === b.roomId ? ">>> SAME ROOM" : ">>> DIFFERENT ROOMS");
    break;
  }
  await sleep(1500);
}
await shot(A.page, "rc-a");
await shot(B.page, "rc-b");
await browser.close();
