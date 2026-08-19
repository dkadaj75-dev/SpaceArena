/**
 * ROADMAP §10 5.7 — the sound registry: **sound id → synth function**.
 *
 * Every sound is generated with the Web Audio API (oscillators + one shared
 * noise buffer); the game ships no audio files. These are deliberately
 * placeholder-grade: the point is that every id referenced from content
 * (`action.play_sound.params.sound`, `effect.sound`, `theme.audio.cues`)
 * resolves to *something* audible, so real samples can replace a synth entry
 * later without touching a single call site.
 *
 * Adding a sound = one entry in {@link SOUND_SYNTHS} + the id in content.
 * An id with no entry warns once in {@link import("./AudioManager.js").AudioManager}
 * and plays nothing — never a crash.
 */

/** Everything a synth needs; supplied by the AudioManager per play. */
export interface SynthTarget {
  ctx: BaseAudioContext;
  /** Where the voice connects — the manager's sfx gain node, never `destination` directly. */
  destination: AudioNode;
  /** Shared 1s mono white-noise buffer (built once per context). */
  noise: AudioBuffer;
  /** Schedule time (`ctx.currentTime`), read once so one voice's nodes stay in phase. */
  now: number;
}

/** Builds and starts one voice. Returns its duration in seconds. */
export type SynthFn = (t: SynthTarget) => number;

interface ToneOptions {
  type: OscillatorType;
  /** Start frequency (Hz). */
  from: number;
  /** End frequency (Hz); equal to `from` for a steady tone. */
  to?: number;
  duration: number;
  peak: number;
  /** Attack ramp as a fraction of `duration`. */
  attack?: number;
  /** Delay before the voice starts, seconds. */
  delay?: number;
}

/** One oscillator + its own gain envelope, connected to the target. */
function tone(t: SynthTarget, o: ToneOptions): number {
  const start = t.now + (o.delay ?? 0);
  const end = start + o.duration;
  const osc = t.ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.from, start);
  if (o.to !== undefined && o.to !== o.from) {
    // Exponential ramps model pitch the way ears hear it, and never touch 0.
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), end);
  }
  const gain = t.ctx.createGain();
  const attack = Math.max(0.002, o.duration * (o.attack ?? 0.08));
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(o.peak, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(t.destination);
  osc.start(start);
  osc.stop(end);
  return (o.delay ?? 0) + o.duration;
}

interface NoiseOptions {
  duration: number;
  peak: number;
  /** Band-limiting sweep applied to the burst. */
  filter?: { type: BiquadFilterType; from: number; to?: number; q?: number };
  delay?: number;
}

/** A slice of the shared noise buffer through an optional filter sweep. */
function noise(t: SynthTarget, o: NoiseOptions): number {
  const start = t.now + (o.delay ?? 0);
  const end = start + o.duration;
  const src = t.ctx.createBufferSource();
  src.buffer = t.noise;
  const gain = t.ctx.createGain();
  gain.gain.setValueAtTime(o.peak, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  if (o.filter) {
    const biquad = t.ctx.createBiquadFilter();
    biquad.type = o.filter.type;
    biquad.frequency.setValueAtTime(o.filter.from, start);
    if (o.filter.to !== undefined) {
      biquad.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.to), end);
    }
    if (o.filter.q !== undefined) biquad.Q.setValueAtTime(o.filter.q, start);
    src.connect(biquad);
    biquad.connect(gain);
  } else {
    src.connect(gain);
  }
  gain.connect(t.destination);
  src.start(start);
  src.stop(end);
  return (o.delay ?? 0) + o.duration;
}

function longest(...durations: number[]): number {
  let max = 0;
  for (const d of durations) if (d > max) max = d;
  return max;
}

/**
 * id → synth. Ids are content-facing: renaming one is a content migration, so
 * treat this map as the published vocabulary.
 */
export const SOUND_SYNTHS: Record<string, SynthFn> = {
  // --- weapons -------------------------------------------------------------
  /** Laser: bright descending zap. */
  laser_fire: (t) =>
    longest(
      tone(t, { type: "sawtooth", from: 1180, to: 240, duration: 0.13, peak: 0.22, attack: 0.02 }),
      tone(t, { type: "square", from: 2400, to: 900, duration: 0.07, peak: 0.06, attack: 0.02 }),
    ),
  /** Autocannon: dry mechanical thud with a click transient. */
  kinetic_fire: (t) =>
    longest(
      noise(t, { duration: 0.09, peak: 0.32, filter: { type: "lowpass", from: 1600, to: 320 } }),
      tone(t, { type: "triangle", from: 190, to: 70, duration: 0.12, peak: 0.24, attack: 0.01 }),
    ),
  /** Missile: filtered noise whoosh sweeping up and away. */
  missile_fire: (t) =>
    longest(
      noise(t, { duration: 0.5, peak: 0.2, filter: { type: "bandpass", from: 420, to: 2600, q: 1.2 } }),
      tone(t, { type: "sine", from: 160, to: 320, duration: 0.35, peak: 0.1 }),
    ),

  // --- impacts / feedback --------------------------------------------------
  /** Own hull taking damage. */
  hit_thud: (t) =>
    longest(
      tone(t, { type: "sine", from: 220, to: 62, duration: 0.18, peak: 0.3, attack: 0.01 }),
      noise(t, { duration: 0.08, peak: 0.16, filter: { type: "lowpass", from: 900, to: 200 } }),
    ),
  /** Shield soaking a hit — bright, glassy. */
  shield_hit: (t) =>
    longest(
      tone(t, { type: "sine", from: 1500, to: 820, duration: 0.14, peak: 0.16, attack: 0.01 }),
      tone(t, { type: "sine", from: 2300, to: 1600, duration: 0.1, peak: 0.07, attack: 0.01 }),
    ),
  /** Kill confirm: two-note rising blip. */
  kill_confirm: (t) =>
    longest(
      tone(t, { type: "square", from: 680, to: 700, duration: 0.07, peak: 0.14 }),
      tone(t, { type: "square", from: 1020, to: 1050, duration: 0.12, peak: 0.14, delay: 0.08 }),
    ),

  // --- module states -------------------------------------------------------
  /** Shield raised: rising sweep. */
  shield_up: (t) =>
    longest(
      tone(t, { type: "sine", from: 280, to: 900, duration: 0.32, peak: 0.16, attack: 0.2 }),
      tone(t, { type: "triangle", from: 560, to: 1800, duration: 0.28, peak: 0.06, attack: 0.25 }),
    ),
  /** Shield dropped: falling sweep. */
  shield_down: (t) => tone(t, { type: "sine", from: 880, to: 240, duration: 0.3, peak: 0.14, attack: 0.05 }),
  /** Afterburner ignition. */
  boost_engage: (t) =>
    longest(
      noise(t, { duration: 0.4, peak: 0.16, filter: { type: "lowpass", from: 400, to: 2200 } }),
      tone(t, { type: "sawtooth", from: 110, to: 300, duration: 0.35, peak: 0.12, attack: 0.3 }),
    ),
  /** Afterburner cut. */
  boost_disengage: (t) =>
    noise(t, { duration: 0.25, peak: 0.12, filter: { type: "lowpass", from: 1800, to: 260 } }),
  /** Overheat force-shutdown: two-tone alarm. */
  overheat_warning: (t) =>
    longest(
      tone(t, { type: "square", from: 880, to: 880, duration: 0.12, peak: 0.16 }),
      tone(t, { type: "square", from: 620, to: 620, duration: 0.16, peak: 0.16, delay: 0.15 }),
    ),
  /** Arena boundary contact. */
  boundary_warn: (t) =>
    longest(
      tone(t, { type: "square", from: 300, to: 300, duration: 0.1, peak: 0.12 }),
      tone(t, { type: "square", from: 300, to: 300, duration: 0.1, peak: 0.12, delay: 0.16 }),
    ),

  // --- sensors (FLIGHT.md §2/§4) -------------------------------------------
  /** Lock complete — short rising double tick, deliberately quieter than a kill. */
  lock_acquired: (t) =>
    longest(
      tone(t, { type: "sine", from: 1180, to: 1180, duration: 0.05, peak: 0.1 }),
      tone(t, { type: "sine", from: 1620, to: 1620, duration: 0.08, peak: 0.11, delay: 0.06 }),
    ),
  /** Lock broken — the same figure inverted, so the two never get confused. */
  lock_lost: (t) =>
    longest(
      tone(t, { type: "sine", from: 1180, to: 1180, duration: 0.05, peak: 0.08 }),
      tone(t, { type: "sine", from: 720, to: 660, duration: 0.1, peak: 0.09, delay: 0.06 }),
    ),
  /** Trigger rejected by the lock gate — low, dry double error tick. */
  fire_blocked: (t) =>
    longest(
      tone(t, { type: "square", from: 260, to: 220, duration: 0.06, peak: 0.1 }),
      tone(t, { type: "square", from: 220, to: 180, duration: 0.09, peak: 0.1, delay: 0.09 }),
    ),

  // --- match start countdown -----------------------------------------------
  /** "3 … 2 … 1": one dry, unmistakable pip per second. */
  countdown_tick: (t) => tone(t, { type: "square", from: 720, to: 720, duration: 0.09, peak: 0.13 }),
  /**
   * "GO": the same figure resolved upward an octave and held, so the release is
   * audibly the END of the sequence rather than a fourth pip.
   */
  countdown_go: (t) =>
    longest(
      tone(t, { type: "square", from: 720, to: 1440, duration: 0.14, peak: 0.16 }),
      tone(t, { type: "sine", from: 1440, to: 1440, duration: 0.3, peak: 0.12, attack: 0.05, delay: 0.12 }),
    ),

  // --- hangar launch sequence (PLACEHOLDERS) -------------------------------
  // Deliberately separate ids from the match countdown above: this beat is a
  // bay PA talking to one pilot, not the arena-wide start gun, and the two are
  // heard back to back at match start. All three are stubs — swap the synth for
  // a sample without touching a call site (see {@link HANGAR_LAUNCH_SOUNDS}).
  /** "3 … 2 … 1": a dull bay klaxon pip, an octave under the match tick. */
  hangar_countdown_tick: (t) =>
    longest(
      tone(t, { type: "square", from: 360, to: 360, duration: 0.11, peak: 0.11 }),
      noise(t, { duration: 0.06, peak: 0.05, filter: { type: "lowpass", from: 700, to: 220 } }),
    ),
  /** Clearance granted — the doors are open and the pad is yours. */
  hangar_countdown_go: (t) =>
    longest(
      tone(t, { type: "sawtooth", from: 300, to: 600, duration: 0.22, peak: 0.14, attack: 0.06 }),
      tone(t, { type: "sine", from: 900, to: 900, duration: 0.36, peak: 0.1, attack: 0.08, delay: 0.16 }),
    ),
  /**
   * Engine ramp for the sim-flown run: a low rumble swelling under a rising
   * sawtooth. Sized to the launch run (~1.5 s) so it lands with the ship
   * leaving the bay rather than trailing behind it.
   */
  launch_thrust: (t) =>
    longest(
      noise(t, { duration: 1.5, peak: 0.26, filter: { type: "lowpass", from: 240, to: 1400 } }),
      tone(t, { type: "sawtooth", from: 55, to: 190, duration: 1.4, peak: 0.2, attack: 0.35 }),
      tone(t, { type: "sine", from: 38, to: 90, duration: 1.5, peak: 0.24, attack: 0.25 }),
    ),

  // --- explosions (variants selected from effect configs) ------------------
  /** Light hull: quick crack. */
  explosion_light: (t) =>
    longest(
      noise(t, { duration: 0.42, peak: 0.36, filter: { type: "lowpass", from: 2600, to: 260 } }),
      tone(t, { type: "triangle", from: 200, to: 55, duration: 0.34, peak: 0.24, attack: 0.01 }),
    ),
  /** Medium hull / generic ship. */
  explosion_ship: (t) =>
    longest(
      noise(t, { duration: 0.62, peak: 0.42, filter: { type: "lowpass", from: 2000, to: 180 } }),
      tone(t, { type: "triangle", from: 160, to: 42, duration: 0.5, peak: 0.28, attack: 0.01 }),
    ),
  /** Heavy hull: long, low, chest-thumping. */
  explosion_heavy: (t) =>
    longest(
      noise(t, { duration: 0.9, peak: 0.46, filter: { type: "lowpass", from: 1500, to: 120 } }),
      tone(t, { type: "sine", from: 120, to: 32, duration: 0.75, peak: 0.34, attack: 0.01 }),
      noise(t, { duration: 0.3, peak: 0.2, filter: { type: "highpass", from: 900, to: 2400 }, delay: 0.05 }),
    ),
  /** Asteroid: gritty, no low-end boom. */
  explosion_rock: (t) =>
    longest(
      noise(t, { duration: 0.45, peak: 0.3, filter: { type: "bandpass", from: 1500, to: 380, q: 0.8 } }),
      tone(t, { type: "triangle", from: 130, to: 60, duration: 0.28, peak: 0.14, attack: 0.02 }),
    ),
};

/** Every registered sound id (used by tests and the dev audio probe). */
export const SOUND_IDS: readonly string[] = Object.keys(SOUND_SYNTHS);
