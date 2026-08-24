// A thumb-driven pilot: holds a floating steer finger on the canvas, works the
// throttle lever, and holds the weapon triggers — all through real CDP touch.
import { sleep, centreOf, readState } from "./rig.mjs";

const F_STEER = 1;
const F_THROTTLE = 2;
const F_W1 = 3;
const F_W2 = 4;
const F_TAP = 5;

const angleTo = (from, to) => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Pilot {
  constructor(c) {
    this.c = c;
    this.goal = "chase";
    this.fireSlots = new Set();
    this.throttleWant = 0;
    this.throttleSet = -1;
    this.running = false;
    this.steerOrigin = null;
    /** Radial distance from arena centre to aim for in "boundary" goal. */
    this.boundaryPush = 999;
    this.last = null;
    this.events = [];
    this.tick = 0;
    /** How many times the floating steer drag had to be re-taken. */
    this.steerDrops = 0;
    this.spawn = { x: 0, z: 0 };
    this.flown = 0;
  }

  note(s) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${this.c.tag}: ${s}`;
    this.events.push(line);
    console.log("    " + line);
  }

  /** A canvas point that the steer input will actually accept. */
  async findSteerOrigin() {
    const pt = await this.c.page.evaluate(() => {
      const cands = [
        [300, 210], [250, 330], [430, 340], [200, 130], [620, 340],
        [460, 210], [150, 250], [700, 180], [360, 120], [520, 380],
      ];
      const isCtl = (el) => {
        for (let n = el; n; n = n.parentElement) if (n.hasAttribute?.("data-hud-control")) return true;
        return false;
      };
      for (const [x, y] of cands) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.id === "renderCanvas" && !isCtl(el)) return { x, y, tag: el.id };
      }
      const el = document.elementFromPoint(460, 210);
      return { x: 460, y: 210, tag: el ? `${el.tagName}.${el.className}` : "none", fallback: true };
    });
    this.steerOrigin = pt;
    this.note(`steer origin ${pt.x},${pt.y} on ${pt.tag}${pt.fallback ? " (FALLBACK)" : ""}`);
    return pt;
  }

  async pressSteer() {
    if (!this.steerOrigin) await this.findSteerOrigin();
    if (!this.c.touch.isDown(F_STEER)) {
      await this.c.touch.down(F_STEER, this.steerOrigin.x, this.steerOrigin.y);
    }
  }
  async releaseSteer() {
    await this.c.touch.up(F_STEER);
  }

  /** Drag the throttle lever to `want` (0..1) and let go — it is a lever. */
  async setThrottle(want) {
    const track = this.c.page.locator(".hud-throttle-track");
    const b = await track.boundingBox().catch(() => null);
    if (!b) return;
    const y = b.y + (1 - clamp(want, 0, 1)) * b.height;
    const x = b.x + b.width / 2;
    await this.c.touch.down(F_THROTTLE, x, b.y + b.height * 0.5);
    await this.c.touch.move(F_THROTTLE, x, y);
    await sleep(40);
    await this.c.touch.up(F_THROTTLE);
    this.throttleSet = want;
  }

  async weaponBox(slot) {
    const l = this.c.page.locator(`.hud-module-btn[data-side="weapons"][data-slot="${slot}"]`);
    return (await l.count()) ? centreOf(l) : null;
  }

  async holdWeapon(slot) {
    const finger = slot === "01" ? F_W1 : F_W2;
    if (this.c.touch.isDown(finger)) return;
    const p = await this.weaponBox(slot);
    if (!p) return this.note(`weapon slot ${slot} not on the HUD`);
    await this.c.touch.down(finger, p.x, p.y);
    this.note(`holding trigger ${slot}`);
  }
  async releaseWeapon(slot) {
    await this.c.touch.up(slot === "01" ? F_W1 : F_W2);
  }
  async releaseWeapons() {
    await this.c.touch.up(F_W1);
    await this.c.touch.up(F_W2);
  }

  /** Every module button the HUD is showing, with the label under its glyph. */
  async listModules() {
    return this.c.page.locator(".hud-module-btn").evaluateAll((els) =>
      els.map((e) => ({
        side: e.dataset.side ?? "",
        slot: e.dataset.slot ?? "",
        control: e.dataset.hudControl ?? "",
        type: e.querySelector(".slot-type")?.textContent ?? "",
        label: e.querySelector(".label")?.textContent ?? "",
        cls: e.className,
      })),
    );
  }

  /** Tap a non-weapon module button by the type printed on it (SHIELD, BOOST…). */
  async toggleModule(typeText) {
    const btn = this.c.page
      .locator(".hud-module-btn")
      .filter({ has: this.c.page.locator(`.slot-type:text-is("${typeText}")`) })
      .first();
    if (!(await btn.count())) {
      this.note(`no ${typeText} button on the HUD`);
      return null;
    }
    const before = await btn.getAttribute("class");
    const p = await centreOf(btn);
    if (!p) return null;
    await this.c.touch.tap(p.x, p.y, F_TAP, 70);
    await sleep(700);
    const after = await btn.getAttribute("class");
    this.note(`${typeText}: "${before}" -> "${after}"`);
    return { before, after };
  }

  async tapControl(selector) {
    const l = this.c.page.locator(selector).first();
    if (!(await l.count())) return false;
    const p = await centreOf(l);
    if (!p) return false;
    await this.c.touch.tap(p.x, p.y, F_TAP, 70);
    return true;
  }

  /** One decision + one steer update. */
  async step() {
    const st = await readState(this.c.page).catch(() => null);
    this.last = st;
    this.tick += 1;
    if (!st?.live || !st.me) {
      // Dead: the ship leaves the snapshot entirely until it respawns, and the
      // steer drag has to be re-taken on the new hull.
      if (this.c.touch.isDown(F_STEER)) await this.c.touch.up(F_STEER);
      return st;
    }
    const me = st.me;
    if (this.tick === 1 || (this.spawn.x === 0 && this.spawn.z === 0)) this.spawn = { x: me.x, z: me.z };

    // Dead / on the launch pad: nothing to steer.
    if (me.hull !== undefined && me.hull <= 0) {
      await this.releaseWeapons();
      return st;
    }

    let turn = 0;
    let pitch = 0;
    let throttle = this.throttleWant;

    const foes = st.ships.filter((s) => s.team !== me.team);
    let target = null;
    let dist = Infinity;
    for (const f of foes) {
      const d = Math.hypot(f.x - me.x, f.z - me.z, (f.y ?? 0) - (me.y ?? 0));
      if (d < dist) {
        dist = d;
        target = f;
      }
    }

    if (this.goal === "boundary") {
      // Straight out from the arena centre, hard.
      const r = Math.hypot(me.x, me.z) || 1;
      const bearing = Math.atan2(me.z / r, me.x / r);
      turn = clamp(angleTo(me.heading, bearing) * 2, -1, 1);
      pitch = clamp(-(me.pitch ?? 0) * 1.5, -1, 1);
      throttle = 1;
    } else if (this.goal === "hold") {
      turn = 0;
      pitch = 0;
      throttle = 0;
    } else if (target) {
      const bearing = Math.atan2(target.z - me.z, target.x - me.x);
      turn = clamp(angleTo(me.heading, bearing) * 2.2, -1, 1);
      const flat = Math.hypot(target.x - me.x, target.z - me.z) || 1;
      const wantPitch = Math.atan2((target.y ?? 0) - (me.y ?? 0), flat);
      pitch = clamp((wantPitch - (me.pitch ?? 0)) * 2, -1, 1);
      const band = this.goal === "close" ? 22 : 42;
      throttle = dist > band ? (dist > 140 ? 1 : 0.75) : 0.15;
    }

    // Screen offsets: screen-right is a NEGATIVE sim turn, screen-down a
    // NEGATIVE pitch (flightInput.ts sign constants), so both invert.
    const R = 95;
    const dx = -turn * R;
    const dy = -pitch * R;

    // Self-heal: the floating steer drag is a real pointer, and anything that
    // cancels it (a lost capture, a death, the throttle thumb) leaves the ship
    // flying straight. `steerActive` is the widget's own live state.
    if (!st.steerActive && this.c.touch.isDown(F_STEER)) {
      this.steerDrops += 1;
      await this.c.touch.up(F_STEER);
    }
    const fresh = !this.c.touch.isDown(F_STEER);
    await this.pressSteer();
    // A fresh press starts at the origin, so nudge it off-centre in two steps
    // — one move from dead centre is what the widget reads as the deflection.
    if (fresh) await this.c.touch.moveMany([[F_STEER, this.steerOrigin.x + dx * 0.5, this.steerOrigin.y + dy * 0.5]]);
    await this.c.touch.moveMany([[F_STEER, this.steerOrigin.x + dx, this.steerOrigin.y + dy]]);

    if (Math.abs(throttle - this.throttleSet) > 0.12) await this.setThrottle(throttle);

    this.flown = Math.max(this.flown, Math.hypot(me.x - this.spawn.x, me.z - this.spawn.z));
    return { ...st, dist, targetId: target?.id ?? null };
  }

  /** Fly for `ms`, stepping ~9 Hz, while the caller does other things. */
  async fly(ms, onTick) {
    const end = Date.now() + ms;
    this.running = true;
    while (Date.now() < end && this.running) {
      const st = await this.step();
      if (onTick) await onTick(st);
      // Nothing after the results overlay is flying any more.
      if (st?.resultsUp) break;
      await sleep(110);
    }
    this.running = false;
    return this.last;
  }

  async allStop() {
    this.running = false;
    await this.c.touch.releaseAll();
  }
}

export { angleTo, clamp };
