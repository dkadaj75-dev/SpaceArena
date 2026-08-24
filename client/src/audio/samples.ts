import { createLogger } from "@space-arena/shared";

/**
 * ROADMAP §10 5.7 — the authored-sample layer: **sound id → recorded file**.
 *
 * This sits beside {@link import("./synths.js").SOUND_SYNTHS} and shares its
 * vocabulary: an id listed here is the SAME id content already references, so
 * giving a weapon a real recording is one entry in {@link SOUND_SAMPLES} and no
 * call-site change at all. The synth for that id stays registered and becomes
 * its fallback — a sample that has not finished decoding (or that failed to
 * load) must never make the game go quiet mid-fight.
 *
 * Files are fetched exactly the way music is (see `MusicController`): a plain
 * content-relative path decoded once into an AudioBuffer and cached forever.
 * Loading is lazy — nothing is fetched until the first shot asks for it — so a
 * player who never equips an autocannon never pays for its wav.
 */

const log = createLogger("Audio");

export interface SampleSpec {
  /** Content-relative path, served from the repo `content/` tree like music. */
  src: string;
  /**
   * True for the recording of a CHANNEL rather than of a shot: it is started as
   * a looping source when the weapon starts firing and stopped when it stops,
   * so its length is the file's, not the weapon's. Such an id is never played
   * as a one-shot once its file is decoded — see
   * {@link import("./AudioManager.js").AudioManager.playLoop}.
   */
  loop?: boolean;
}

/**
 * id → authored sample. Every id here must also exist in `SOUND_SYNTHS`, which
 * is what plays until the file is decoded (`AudioManager.test.ts` asserts it).
 */
export const SOUND_SAMPLES: Record<string, SampleSpec> = {
  /** Autocannon burst, 0.4 s — a discrete shot, so overlapping copies are wanted. */
  kinetic_fire: { src: "content/sounds/AutocannonFire.wav" },
  /** Sustained Beam, 2.25 s — looped for as long as the beam is channelling. */
  beam_fire: { src: "content/sounds/SustainedBeam.mp3", loop: true },
};

/** Every id backed by an authored sample (used by tests and the dev probe). */
export const SAMPLED_SOUND_IDS: readonly string[] = Object.keys(SOUND_SAMPLES);

/** Binary loader seam for tests; production fetches the authored content path. */
export type SampleLoader = (src: string) => Promise<ArrayBuffer>;

export interface SampleLibraryOptions {
  load?: SampleLoader;
  logger?: Pick<typeof log, "warn">;
}

/**
 * Lazily fetches and decodes {@link SOUND_SAMPLES}, one AudioBuffer per id.
 *
 * {@link bufferFor} is deliberately synchronous and non-blocking: it returns the
 * decoded buffer or `null`, and `null` means "use the synth this time". The
 * first `null` kicks the fetch off in the background, so the very first shot of
 * a match is synthesized and every later one is the real recording.
 */
export class SampleLibrary {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Set<string>();
  /** Ids whose fetch/decode failed — never retried, warned about exactly once. */
  private readonly failed = new Set<string>();
  private readonly load: SampleLoader;
  private readonly logger: Pick<typeof log, "warn">;

  constructor(options: SampleLibraryOptions = {}) {
    this.load = options.load ?? loadBinary;
    this.logger = options.logger ?? log;
  }

  /** The decoded buffer for `id`, or null while it is missing (starts the load). */
  bufferFor(id: string, ctx: BaseAudioContext): AudioBuffer | null {
    const ready = this.buffers.get(id);
    if (ready) return ready;
    const spec = SOUND_SAMPLES[id];
    if (!spec || this.pending.has(id) || this.failed.has(id)) return null;
    this.pending.add(id);
    void this.load(spec.src)
      .then((bytes) => ctx.decodeAudioData(bytes.slice(0)))
      .then((buffer) => {
        this.buffers.set(id, buffer);
      })
      .catch((error: unknown) => {
        this.failed.add(id);
        this.logger.warn(`sound sample "${id}" failed to load from "${spec.src}"; using its synth instead`, {
          error,
        });
      })
      .finally(() => {
        this.pending.delete(id);
      });
    return null;
  }

  /** True once `id`'s file is decoded and ready (dev probe/tests). */
  isLoaded(id: string): boolean {
    return this.buffers.has(id);
  }

  /** Drop every decoded buffer — the context they were decoded against is gone. */
  clear(): void {
    this.buffers.clear();
    this.pending.clear();
    this.failed.clear();
  }
}

async function loadBinary(src: string): Promise<ArrayBuffer> {
  const response = await fetch(src, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}
