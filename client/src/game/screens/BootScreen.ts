/**
 * Driver for the launch sequence.
 *
 * The MARKUP lives in `client/index.html`, not here, and that is the whole
 * point: it is static, styled by an inline `<style>` in the same document, and
 * therefore on screen with the first paint — before the module graph has been
 * fetched, before Babylon exists, and before the content pack has loaded. A
 * screen built in TypeScript could only appear after all of that, which is
 * exactly the window a player stares at a black page and wonders whether the
 * server is up.
 *
 * This class only *drives* it: mark a stage active, settle it ok/fail, push a
 * note, then fade out. Every method is a no-op when the markup is absent (unit
 * tests, the dev editor's own entry, a stripped embed), so nothing downstream
 * has to null-check.
 */

/** The three things that must happen before the menu can be trusted. */
export type BootStageId = "content" | "interface" | "server";

/**
 * `warn` is the state that matters: a stage that did NOT succeed but must not
 * stop the boot, such as a server that never answered. The player still reaches
 * the menu; the mark and the note say what they lost.
 */
export type BootStageState = "pending" | "active" | "ok" | "warn" | "fail";

const STAGE_IDS: readonly BootStageId[] = ["content", "interface", "server"];

/** How long the fade-out lasts. Must match `.sa-boot` transition in index.html. */
const FADE_MS = 320;

/**
 * How long the publisher card owns the screen. Loading runs behind it the whole
 * time — this beat costs the player nothing, it just spends the opening of an
 * unavoidable wait on the logo instead of on a progress bar.
 *
 * 1000 → 1500 on 2026-08-21 at the owner's request: the card was gone before
 * the fade-in had finished reading as one.
 */
export const PUBLISHER_MS = 1500;

/**
 * The title screen's MINIMUM dwell. It stays at least this long so the wordmark
 * and the nebula register, and longer whenever loading has not finished — the
 * menu is never shown before it is real.
 *
 * (The design note said "1.5 s or until loaded, whichever is less". Taken
 * literally the number can never bind: you cannot leave a title screen into a
 * game that has not loaded, so the shorter of the two is always the load. Read
 * as a MINIMUM it does what the note plainly wants — a title screen that is
 * actually seen — so that is what this is.)
 */
export const TITLE_MIN_MS = 1500;

/** The phases the markup cross-fades between. */
export type BootPhase = "publisher" | "title";

export class BootScreen {
  private readonly stages = new Map<BootStageId, HTMLElement>();
  private settled = 0;
  /**
   * The publisher → title timeline, started at construction so it runs
   * CONCURRENTLY with the load rather than being sequenced by the caller.
   * `dismiss` awaits it, which is what guarantees the title screen is seen
   * even when the pack loads faster than the animation.
   */
  private readonly intro: Promise<void>;

  private constructor(
    private readonly root: HTMLElement,
    private readonly fill: HTMLElement | null,
    private readonly subEl: HTMLElement | null,
    private readonly noteEl: HTMLElement | null,
  ) {
    for (const id of STAGE_IDS) {
      const el = root.querySelector<HTMLElement>(`[data-boot-stage="${id}"]`);
      if (el) this.stages.set(id, el);
    }
    this.intro = this.runIntro();
  }

  /**
   * Publisher card, then the title screen, then the minimum title dwell.
   * Nothing here waits on the load: the load is already running.
   */
  private async runIntro(): Promise<void> {
    this.phase("publisher");
    await delay(PUBLISHER_MS);
    this.phase("title");
    await delay(TITLE_MIN_MS);
  }

  /** Which phase the markup shows. No-op once the screen has been removed. */
  private phase(phase: BootPhase): void {
    if (!this.root.isConnected) return;
    this.root.dataset["phase"] = phase;
  }

  /**
   * Adopt the boot markup if this document has it. Returns null when it does
   * not, which callers are expected to treat as "nothing to drive" rather than
   * as an error.
   */
  static attach(doc: Document = document): BootScreen | null {
    const root = doc.getElementById("sa-boot");
    if (!root) return null;
    return new BootScreen(
      root,
      root.querySelector<HTMLElement>("[data-boot-fill]"),
      root.querySelector<HTMLElement>("[data-boot-sub]"),
      root.querySelector<HTMLElement>("[data-boot-note]"),
    );
  }

  /** Mark a stage as the one currently running. */
  begin(id: BootStageId): void {
    this.setState(id, "active");
  }

  /**
   * Settle a stage and advance the progress bar. `detail` replaces the stage's
   * own label suffix — it is where "timed out", "unreachable" or a version
   * string goes, so the list reads as a log rather than as a promise.
   */
  settle(id: BootStageId, state: Exclude<BootStageState, "pending" | "active">, detail = ""): void {
    const el = this.setState(id, state);
    if (el) {
      const detailEl = el.querySelector<HTMLElement>("[data-boot-detail]");
      if (detailEl) detailEl.textContent = detail;
    }
    this.settled = Math.min(STAGE_IDS.length, this.settled + 1);
    if (this.fill) this.fill.style.width = `${Math.round((this.settled / STAGE_IDS.length) * 100)}%`;
  }

  /** The line under the wordmark — the one-phrase status. */
  subtitle(text: string): void {
    if (this.subEl) this.subEl.textContent = text;
  }

  /**
   * The footer line. Used for the outcome the player has to carry into the
   * menu ("SERVER OFFLINE — online play unavailable") and, in dev, for the
   * server identity the probe read back.
   */
  note(text: string, tone: "info" | "warn" = "info"): void {
    if (!this.noteEl) return;
    this.noteEl.textContent = text;
    this.noteEl.dataset["tone"] = tone;
  }

  /**
   * Hard-fail the screen: the boot itself threw and there will be no menu.
   * Leaves the panel up with the reason on it, because a blank page is the one
   * outcome that tells the player nothing at all.
   */
  fail(reason: string): void {
    // A failure has something to say, so jump straight to the screen that has
    // room to say it rather than announcing it over the publisher logo.
    this.phase("title");
    this.subtitle("LAUNCH FAILED");
    this.note(reason, "warn");
    this.root.dataset["state"] = "failed";
    for (const [id, el] of this.stages) {
      if (el.dataset["state"] === "active") this.setState(id, "fail");
    }
  }

  /**
   * Fade out and remove the screen. `holdMs` keeps it up a moment longer, which
   * is what a "server offline" outcome wants — the badge in the lobby repeats
   * the message, but the player should get to read it here first.
   *
   * Resolves once the node is gone; safe to call twice.
   */
  async dismiss(holdMs = 0): Promise<void> {
    if (!this.root.isConnected) return;
    // The launch sequence owns its own minimum runtime. A pack that loads in
    // 200 ms must not flash the publisher card and cut — the player would see
    // a stutter of black and never read either screen.
    await this.intro;
    if (!this.root.isConnected) return;
    if (holdMs > 0) await delay(holdMs);
    this.root.dataset["state"] = "done";
    await delay(FADE_MS);
    this.root.remove();
  }

  private setState(id: BootStageId, state: BootStageState): HTMLElement | undefined {
    const el = this.stages.get(id);
    if (el) el.dataset["state"] = state;
    return el;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
