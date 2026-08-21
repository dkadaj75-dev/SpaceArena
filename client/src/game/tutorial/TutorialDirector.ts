import {
  angleDelta,
  createLogger,
  type ConfigService,
  type EntityId,
  type ModuleConfig,
  type ShipSnapshot,
  type SimEvent,
  type Snapshot,
  type TutorialActorRole,
  type TutorialConfig,
  type TutorialSpawn,
  type TutorialStage,
  type TutorialStep,
} from "@space-arena/shared";
import type { GameSession, ScriptedSpawn } from "../GameSession.js";
import { conditionMet, emptySignals, needsAcknowledgement, type MutableStepSignals } from "./tutorialConditions.js";

const log = createLogger("Tutorial");

/** What the coach mark is asked to draw for the step currently running. */
export interface TutorialStepView {
  stepId: string;
  /** 1-based, for the "STEP 3 / 11" counter. */
  index: number;
  total: number;
  instructor: string;
  title: string;
  text: string;
  hint: string | undefined;
  highlight: TutorialStep["highlight"];
  stage: TutorialStage;
  /** True ⇒ the mark shows its confirm button (see `needsAcknowledgement`). */
  confirmable: boolean;
}

/** How a run ended. Both outcomes persist completion — a skip is still a decision. */
export type TutorialOutcome = "completed" | "skipped";

/**
 * Everything the director cannot do for itself. Injected rather than imported so
 * the whole flow is testable with four fakes and no DOM, no Babylon and no sim.
 */
export interface TutorialHost {
  /** Put the player in front of a stage (end the match, open the hangar, …). */
  navigate(stage: TutorialStage): void;
  /** Draw the coach mark, or clear it when passed `null`. */
  present(view: TutorialStepView | null): void;
  /** Run ended. The host clears its director and raises the completion toast. */
  finish(outcome: TutorialOutcome, config: TutorialConfig): void;
}

/**
 * Walks a {@link TutorialConfig}: shows the current step, watches the world for
 * its completion condition, spawns whatever the next step needs, and moves on.
 *
 * It owns NO game logic. Every lesson is a fact it observes — a throttle value
 * in a snapshot, a `lockAcquired` event, a screen the host says was opened — so
 * a step can never claim the player did something the sim disagrees with.
 *
 * Lifecycle: constructed when the player presses TUTORIAL, told about a match
 * with {@link attachMatch} once one exists (and again after each stage change),
 * fed {@link update} and {@link consumeEvents} every frame, and disposed by
 * {@link skip} or by the last step completing.
 */
export class TutorialDirector {
  private readonly steps: readonly TutorialStep[];
  private index = -1;
  private signals: MutableStepSignals = emptySignals();
  private session: GameSession | null = null;
  /** Sim ids of the actors this run has spawned, by role. */
  private readonly actors = new Map<TutorialActorRole, EntityId>();
  /** `holdMs` left to run on a step whose condition has already fired. */
  private holdRemainingMs = 0;
  private awaitingHold = false;
  private finished = false;

  constructor(
    readonly config: TutorialConfig,
    private readonly configs: Pick<ConfigService, "get">,
    private readonly host: TutorialHost,
  ) {
    this.steps = config.steps;
  }

  /** The step on screen, or null before {@link begin} / after the run ends. */
  get currentStep(): TutorialStep | undefined {
    return this.steps[this.index];
  }

  /** 0-based index of the step on screen (-1 before the run starts). */
  get currentIndex(): number {
    return this.index;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Start at step 0. Safe to call once; later calls are ignored. */
  begin(): void {
    if (this.index >= 0 || this.finished) return;
    this.enter(0);
  }

  /**
   * Adopt the live match. Called when the tutorial's flight stage starts, and
   * with `null` when it ends — the menu stages have no session, and every
   * snapshot-driven signal simply goes quiet rather than needing a guard at
   * each read site.
   */
  attachMatch(session: GameSession | null): void {
    this.session = session;
  }

  /**
   * One render frame. Ticks on EVERY frame, match or no match: the hangar and
   * shop lessons have no sim to read and would otherwise never advance.
   *
   * `cur`/`prev` are the render loop's interpolation pair — present only while a
   * match is live, which is why they are optional. Passing them is what lets the
   * accumulated attitude change be measured on sim steps rather than on frames.
   */
  update(dtMs: number, cur?: Snapshot, prev?: Snapshot): void {
    if (this.finished || this.index < 0) return;
    this.signals.elapsedSec += dtMs / 1000;
    const step = this.currentStep;
    if (!step) return;

    if (this.session && cur && prev) this.sampleShip(cur, prev);

    if (this.awaitingHold) {
      this.holdRemainingMs -= dtMs;
      if (this.holdRemainingMs <= 0) this.advance();
      return;
    }
    if (!conditionMet(step.condition, this.signals)) return;
    this.holdRemainingMs = step.holdMs ?? 0;
    if (this.holdRemainingMs > 0) {
      this.awaitingHold = true;
      return;
    }
    this.advance();
  }

  /** Read this frame's snapshot facts off the player's ship. */
  private sampleShip(cur: Snapshot, prev: Snapshot): void {
    const session = this.session;
    if (!session) return;
    const ship = findShip(cur, session.playerId);
    if (!ship) return;
    this.signals.throttle = Math.max(this.signals.throttle, ship.throttle);
    const before = findShip(prev, session.playerId);
    if (before && before !== ship) {
      this.signals.turned +=
        Math.abs(angleDelta(before.heading, ship.heading)) + Math.abs(ship.pitch - before.pitch);
    }
  }

  /** Sim events drained this frame (same array the HUD consumes). */
  consumeEvents(events: readonly SimEvent[]): void {
    if (this.finished || this.index < 0) return;
    const session = this.session;
    if (!session) return;
    const playerId = session.playerId;
    for (const ev of events) {
      switch (ev.type) {
        case "projectileFired":
          if (ev.ownerId === playerId) this.signals.shots++;
          break;
        case "lockAcquired":
          if (ev.entityId === playerId) this.signals.locked = true;
          break;
        case "moduleStateChanged":
          // "Brought it up", not "touched it": a module going down teaches the
          // other half of the lesson but is not the instruction that was given.
          if (ev.entityId === playerId && (ev.to === "active" || ev.to === "deploying")) {
            const family = this.configs.get<ModuleConfig>("module", ev.moduleId)?.family;
            if (family) this.signals.toggled.add(family);
          }
          break;
        case "entityDestroyed": {
          const role = this.roleOf(ev.entityId);
          if (role) this.signals.killed.add(role);
          // The student dying is not a lesson we authored. Cut to the wrap-up
          // rather than leaving them staring at a step they can no longer do.
          if (ev.entityId === playerId) this.bailOutOfFlight();
          break;
        }
        default:
          break;
      }
    }
  }

  /** Which scripted role (if any) an entity id belongs to. */
  private roleOf(id: EntityId): TutorialActorRole | undefined {
    for (const [role, actorId] of this.actors) if (actorId === id) return role;
    return undefined;
  }

  /** The player opened a screen (lobby, hangar, shop). */
  noteScreen(stage: TutorialStage): void {
    if (this.finished || this.index < 0) return;
    this.signals.visited.add(stage);
  }

  /** The hangar's working loadout changed. */
  noteLoadoutChanged(): void {
    this.signals.loadoutChanged = true;
  }

  /** The ownership ledger recorded a purchase. */
  notePurchase(): void {
    this.signals.purchased = true;
  }

  /** The coach mark's confirm button was pressed. */
  acknowledge(): void {
    this.signals.acknowledged = true;
  }

  /** SKIP TUTORIAL. Always available, at every step, on every stage. */
  skip(): void {
    if (this.finished) return;
    log.info("skipped", { step: this.currentStep?.id });
    this.end("skipped");
  }

  private advance(): void {
    const next = this.index + 1;
    if (next >= this.steps.length) {
      this.end("completed");
      return;
    }
    this.enter(next);
  }

  /** Show step `index`: navigate if its stage changed, spawn what it asks for. */
  private enter(index: number): void {
    const previous = this.currentStep;
    const step = this.steps[index];
    if (!step) return;
    this.index = index;
    this.signals = emptySignals();
    this.awaitingHold = false;
    this.holdRemainingMs = 0;
    // A change of stage IS the navigation instruction — content never names a
    // screen twice. Entering the first step navigates unconditionally, because
    // nothing has established where the player is yet.
    if (!previous || previous.stage !== step.stage) this.host.navigate(step.stage);
    if (step.spawn) this.spawn(step.spawn);
    log.info("step", { id: step.id, index: index + 1, of: this.steps.length });
    this.host.present(this.viewOf(step, index));
  }

  private viewOf(step: TutorialStep, index: number): TutorialStepView {
    return {
      stepId: step.id,
      index: index + 1,
      total: this.steps.length,
      instructor: this.config.instructor,
      title: step.title,
      text: step.text,
      hint: step.hint,
      highlight: step.highlight,
      stage: step.stage,
      confirmable: needsAcknowledgement(step.condition),
    };
  }

  private spawn(spawn: TutorialSpawn): void {
    const session = this.session;
    if (!session) {
      log.warn(`step wants a ${spawn.role} but there is no live match`);
      return;
    }
    const request: ScriptedSpawn = {
      shipId: spawn.ship,
      team: spawn.team,
      aheadDistance: spawn.aheadDistance,
    };
    if (spawn.fitting) request.fitting = spawn.fitting;
    if (spawn.profile) request.profile = spawn.profile;
    if (spawn.hull !== undefined) request.hull = spawn.hull;
    if (spawn.callsign) request.displayName = spawn.callsign;
    const id = session.spawnScripted(request);
    if (id !== null) this.actors.set(spawn.role, id);
  }

  /**
   * The player died mid-lesson. Jump straight to the first non-flight step so
   * the run still reaches the hangar and the shop; a tutorial that dead-ends on
   * a death is a tutorial the player quits.
   */
  private bailOutOfFlight(): void {
    const next = this.steps.findIndex((s, i) => i > this.index && s.stage !== "flight");
    log.info("player down mid-tutorial — skipping to the wrap-up");
    if (next < 0) this.end("completed");
    else this.enter(next);
  }

  private end(outcome: TutorialOutcome): void {
    this.finished = true;
    this.host.present(null);
    this.host.finish(outcome, this.config);
  }

  /** Tear down without notifying the host (page unload, hard reset). */
  dispose(): void {
    this.finished = true;
    this.session = null;
    this.host.present(null);
  }
}

function findShip(snapshot: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snapshot.ships.length; i++) if (snapshot.ships[i]!.id === id) return snapshot.ships[i];
  return undefined;
}
