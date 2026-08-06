import {
  createLogger,
  QUALITY_TIERS,
  type ConfigService,
  type QualityTier,
  type ThemeConfig,
  type TuningConfig,
} from "@space-arena/shared";
import type { AudioManager } from "../../audio/AudioManager.js";
import {
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  PAN_SENS_MAX,
  PAN_SENS_MIN,
  STEER_SENS_MAX,
  STEER_SENS_MIN,
  type RendererPref,
  type UserSettings,
  type UserSettingsStore,
} from "../../core/userSettings.js";
import {
  fullscreenSupported,
  isFullscreen,
  onFullscreenChange,
  toggleFullscreen,
} from "../../core/fullscreen.js";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";

const log = createLogger("Settings");

const THEME_ID = "theme.default";

const TIER_LABEL: Record<QualityTier, string> = { low: "Low", med: "Med", high: "High", ultra: "Ultra" };

export interface SettingsHost {
  configs: ConfigService;
  /** Live volume application (the store owns persistence). */
  audio: AudioManager;
  settings: UserSettingsStore;
  /** Called on "Reload now" — injected so tests never touch `location`. */
  reload?: () => void;
}

/** How the screen was opened; drives the close button's label only. */
export type SettingsContext = "menu" | "match";

/**
 * Settings screen (ROADMAP §10 5.8).
 *
 * Every control writes exactly one thing: a patch into
 * {@link UserSettingsStore}. Nothing here reaches into the renderer, the audio
 * graph or the camera — `main.ts` subscribes to the store and applies the whole
 * settings object in one place, so "what a setting does" lives with the
 * consumers rather than being duplicated in the UI. The single exception is the
 * volume sliders, which additionally call {@link AudioManager} while dragging
 * so the player hears the change before releasing (persistence still goes
 * through the store).
 *
 * Content stays the baseline everywhere: camera and haptics settings here are
 * *local overrides* layered on top of `camera.json` / `theme.json`, and the
 * control tunables (tap slop, double-tap window, edge reject) are shown
 * read-only because they are input-feel knobs the designer owns in
 * `tuning.json` — not MVP player settings.
 */
export class SettingsScreen {
  private readonly root: HTMLDivElement;
  private readonly groups: HTMLDivElement;
  private onClose: (() => void) | null = null;
  private onQuitToMenu: (() => void) | null = null;
  /** Rebuilt on every show; each entry re-paints one control from the store. */
  private readonly refreshers: ((values: UserSettings) => void)[] = [];
  private readonly unsubscribe: () => void;
  /**
   * Repaints the fullscreen toggle from the LIVE browser state; rebuilt with
   * the control on every show. Separate from `refreshers` because fullscreen
   * is deliberately not a stored setting — the browser only grants it inside a
   * user gesture, so a persisted value could never be honoured at boot.
   */
  private fullscreenRefresh: (() => void) | null = null;
  private readonly unsubscribeFullscreen: () => void;

  constructor(
    parent: HTMLElement,
    private readonly host: SettingsHost,
  ) {
    injectScreenStyle();
    this.root = document.createElement("div");
    this.root.className = "settings-overlay game-screen sa-screen sa-menu";
    this.root.style.zIndex = "40";
    this.root.style.display = "none";
    this.root.append(createMenuBackdrop());

    const title = document.createElement("h1");
    title.textContent = "SETTINGS";
    title.className = "sa-screen-title";
    this.root.append(title);

    this.groups = document.createElement("div");
    this.groups.className = "sa-settings-groups";
    this.root.append(this.groups);

    parent.append(this.root);

    // Another writer (the dev Quality panel, a second tab) can move a value
    // under us; re-paint whenever the store reports a change.
    this.unsubscribe = this.host.settings.onChange((values) => {
      for (const refresh of this.refreshers) refresh(values);
    });
    // Esc leaves fullscreen without going through our toggle; track the truth.
    this.unsubscribeFullscreen = onFullscreenChange(() => this.fullscreenRefresh?.());
  }

  /**
   * Open the screen. `onClose` fires on Back/Resume (and only then);
   * `onQuitToMenu` (match context) abandons the match for the main menu and
   * deliberately does NOT fire `onClose` — the match teardown owns the cleanup.
   */
  show(options: { context?: SettingsContext; onClose?: () => void; onQuitToMenu?: () => void } = {}): void {
    this.onClose = options.onClose ?? null;
    this.onQuitToMenu = options.onQuitToMenu ?? null;
    applyMenuTheme(this.root, this.host.configs.get<ThemeConfig>("theme", THEME_ID));
    this.build(options.context ?? "menu");
    this.root.style.display = "flex";
    log.info("settings opened", { context: options.context ?? "menu" });
  }

  hide(): void {
    this.root.style.display = "none";
  }

  get isOpen(): boolean {
    return this.root.style.display !== "none";
  }

  private close(): void {
    this.hide();
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private build(context: SettingsContext): void {
    this.refreshers.length = 0;
    this.fullscreenRefresh = null;
    this.groups.replaceChildren();
    this.groups.append(
      this.displayGroup(),
      this.qualityGroup(),
      this.audioGroup(),
      this.feedbackGroup(),
      this.cameraGroup(),
      this.controlsGroup(),
      this.rendererGroup(),
    );

    const back = document.createElement("button");
    back.className = "sa-screen-btn sa-screen-btn--primary sa-button sa-button--primary";
    back.dataset["settingsClose"] = "";
    back.textContent = context === "match" ? "Resume match" : "Back";
    back.addEventListener("click", () => this.close());
    this.groups.append(back);

    // Mid-match escape hatch (owner 2026-07-31): abandon the match and return
    // to the main menu, without hunting for the results screen.
    if (context === "match" && this.onQuitToMenu) {
      const quit = document.createElement("button");
      quit.className = "sa-screen-btn sa-button sa-button--secondary";
      quit.dataset["settingsQuit"] = "";
      quit.textContent = "Quit to main menu";
      quit.addEventListener("click", () => {
        this.hide();
        const cb = this.onQuitToMenu;
        this.onQuitToMenu = null;
        this.onClose = null;
        cb?.();
      });
      this.groups.append(quit);
    }

    const values = this.host.settings.current;
    for (const refresh of this.refreshers) refresh(values);
  }

  // --- Groups -------------------------------------------------------------

  /**
   * Fullscreen — a LIVE browser-state toggle, not a stored setting (see the
   * field comment on {@link fullscreenRefresh}). The click handler itself is
   * the user gesture the Fullscreen API requires, which is why this control,
   * like the volume sliders, acts directly instead of writing a store patch.
   */
  private displayGroup(): HTMLElement {
    const group = settingsGroup("Display");
    const supported = fullscreenSupported();
    const toggle = toggleButton("Fullscreen", () => {
      void toggleFullscreen().then((on) => toggle.set(on));
    });
    toggle.el.dataset["setting"] = "display.fullscreen";
    toggle.el.disabled = !supported;
    this.fullscreenRefresh = () => toggle.set(isFullscreen());
    this.fullscreenRefresh();
    group.append(toggle.el);
    group.append(
      supported
        ? note("Esc leaves fullscreen. The state is not remembered — browsers only allow entering it from a click.")
        : note("This browser cannot fullscreen web apps (iPhone Safari). Add the game to the home screen for a fullscreen launch instead."),
    );
    return group;
  }

  /** Render quality: Auto (device probe + FPS) or a pinned tier. */
  private qualityGroup(): HTMLElement {
    const group = settingsGroup("Graphics");
    const row = settingsRow("Quality");
    const seg = document.createElement("div");
    seg.className = "sa-seg";
    seg.dataset["setting"] = "quality";

    const options: { value: QualityTier | null; label: string }[] = [
      { value: null, label: "Auto" },
      ...QUALITY_TIERS.map((tier) => ({ value: tier as QualityTier, label: TIER_LABEL[tier] ?? tier })),
    ];
    const buttons = options.map(({ value, label }) => {
      const b = segButton(label, () => this.host.settings.set({ quality: value }));
      b.dataset["quality"] = value ?? "auto";
      seg.append(b);
      return { b, value };
    });
    this.refreshers.push((values) => {
      for (const { b, value } of buttons) b.setAttribute("aria-pressed", String(values.quality === value));
    });

    row.append(seg);
    group.append(row, note("Auto probes the device and re-checks measured FPS in the first seconds of a match. A pinned tier disables that."));
    return group;
  }

  private audioGroup(): HTMLElement {
    const group = settingsGroup("Audio");
    group.append(
      this.volumeRow("Master volume", "master", (v) => {
        this.host.audio.setMasterVolume(v, { persist: false });
        this.host.settings.set({ masterVolume: v });
      }, (values) => values.masterVolume),
      this.volumeRow("Effects volume", "sfx", (v) => {
        this.host.audio.setSfxVolume(v, { persist: false });
        this.host.settings.set({ sfxVolume: v });
      }, (values) => values.sfxVolume),
    );
    return group;
  }

  private volumeRow(
    label: string,
    key: string,
    apply: (value: number) => void,
    read: (values: UserSettings) => number,
  ): HTMLElement {
    const row = settingsRow(label);
    const valueEl = row.querySelector<HTMLSpanElement>(".value")!;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "sa-slider";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.05";
    slider.dataset["setting"] = `volume.${key}`;
    // `input` (not `change`) so dragging is audible immediately.
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      valueEl.textContent = percent(value);
      apply(value);
    });
    this.refreshers.push((values) => {
      const value = read(values);
      slider.value = String(value);
      valueEl.textContent = percent(value);
    });
    row.append(slider);
    return row;
  }

  /** Haptics — a local opt-out layered on the theme's master switch. */
  private feedbackGroup(): HTMLElement {
    const group = settingsGroup("Feedback");
    const themeEnabled = this.host.configs.get<ThemeConfig>("theme", THEME_ID)?.haptics?.enabled ?? false;
    const toggle = toggleButton("Vibration (overheat / kill)", (next) => this.host.settings.set({ haptics: next }));
    toggle.el.dataset["setting"] = "haptics";
    toggle.el.disabled = !themeEnabled;
    this.refreshers.push((values) => toggle.set(themeEnabled && values.haptics));
    group.append(toggle.el);
    if (!themeEnabled) group.append(note("The current theme disables haptics for everyone (theme.haptics.enabled)."));
    else group.append(note("Devices without a vibration motor (desktop, iOS Safari) ignore this."));
    return group;
  }

  private cameraGroup(): HTMLElement {
    const group = settingsGroup("Camera");

    const distanceRow = settingsRow("Camera distance");
    const distanceValue = distanceRow.querySelector<HTMLSpanElement>(".value")!;
    const distanceSlider = document.createElement("input");
    distanceSlider.type = "range";
    distanceSlider.className = "sa-slider";
    distanceSlider.min = String(CAMERA_DISTANCE_MIN);
    distanceSlider.max = String(CAMERA_DISTANCE_MAX);
    distanceSlider.step = "0.05";
    distanceSlider.dataset["setting"] = "camera.distance";
    distanceSlider.addEventListener("input", () => {
      const value = Number(distanceSlider.value);
      distanceValue.textContent = `${Math.round(value * 100)}%`;
      this.host.settings.set({ cameraDistanceScale: value });
    });
    this.refreshers.push((values) => {
      distanceSlider.value = String(values.cameraDistanceScale);
      distanceValue.textContent = `${Math.round(values.cameraDistanceScale * 100)}%`;
    });
    distanceRow.append(distanceSlider);

    const row = settingsRow("Pan sensitivity");
    const valueEl = row.querySelector<HTMLSpanElement>(".value")!;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "sa-slider";
    slider.min = String(PAN_SENS_MIN);
    slider.max = String(PAN_SENS_MAX);
    slider.step = "0.05";
    slider.dataset["setting"] = "camera.panSens";
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      valueEl.textContent = `${value.toFixed(2)}×`;
      this.host.settings.set({ cameraPanSens: value });
    });
    this.refreshers.push((values) => {
      slider.value = String(values.cameraPanSens);
      valueEl.textContent = `${values.cameraPanSens.toFixed(2)}×`;
    });
    row.append(slider);

    const shake = toggleButton("Camera shake", (next) => this.host.settings.set({ cameraShake: next }));
    shake.el.dataset["setting"] = "camera.shake";
    this.refreshers.push((values) => shake.set(values.cameraShake));

    group.append(
      distanceRow,
      row,
      shake.el,
      note("Distance and pan speed multiply their camera.json baselines. Shake amplitudes stay data-driven — this only switches them off."),
    );
    return group;
  }

  /**
   * Player-owned pitch direction and per-device steering multipliers, followed
   * by the fixed bindings and a read-only view of designer-owned feel knobs.
   * Geometry/response baselines stay in `theme.hud.flight`; lock timing stays
   * in `tuning.json`.
   */
  private controlsGroup(): HTMLElement {
    const group = settingsGroup("Controls");
    const flight = this.host.configs.get<ThemeConfig>("theme", THEME_ID)?.hud?.flight;
    const tuning = this.host.configs.getAll<TuningConfig>("tuning")[0];

    const invert = toggleButton("Invert pitch (mouse / touch)", (next) =>
      this.host.settings.set({ invertPitch: next }),
    );
    invert.el.dataset["setting"] = "controls.invertPitch";
    this.refreshers.push((values) => invert.set(values.invertPitch));

    const steerSlider = (
      label: string,
      setting: string,
      read: (values: UserSettings) => number,
      write: (value: number) => void,
    ): HTMLElement => {
      const row = settingsRow(label);
      const valueEl = row.querySelector<HTMLSpanElement>(".value")!;
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "sa-slider";
      slider.min = String(STEER_SENS_MIN);
      slider.max = String(STEER_SENS_MAX);
      slider.step = "0.05";
      slider.dataset["setting"] = setting;
      slider.addEventListener("input", () => {
        const value = Number(slider.value);
        valueEl.textContent = `${value.toFixed(2)}×`;
        write(value);
      });
      this.refreshers.push((values) => {
        const value = read(values);
        slider.value = String(value);
        valueEl.textContent = `${value.toFixed(2)}×`;
      });
      row.append(slider);
      return row;
    };
    const mouseSensitivity = steerSlider(
      "Mouse-look sensitivity",
      "controls.mouseSteerSens",
      (values) => values.mouseSteerSens,
      (value) => this.host.settings.set({ mouseSteerSens: value }),
    );
    const touchSensitivity = steerSlider(
      "Touch-steer sensitivity",
      "controls.touchSteerSens",
      (values) => values.touchSteerSens,
      (value) => this.host.settings.set({ touchSteerSens: value }),
    );

    const bindings = document.createElement("div");
    bindings.className = "sa-settings-readonly";
    bindings.dataset["setting"] = "bindings";
    bindings.append(
      kv("Steer", "Hold right mouse + move  ·  touch and drag"),
      kv("Throttle", "W / S  ·  wheel or drag on the strip"),
      kv("Boost module", "Shift toggles the first fitted boost module"),
    );

    const list = document.createElement("div");
    list.className = "sa-settings-readonly";
    list.dataset["setting"] = "controls";
    const deadzone = flight?.joystick?.deadzone;
    const ramp = flight?.throttle?.keyRampPerSec;
    const wheel = flight?.throttle?.wheelStepPerNotch;
    list.append(
      kv("Stick deadzone", deadzone === undefined ? "—" : `${Math.round(deadzone * 100)}%`),
      kv("Throttle key ramp", ramp === undefined ? "—" : `${ramp}/s`),
      kv("Throttle wheel step", wheel === undefined ? "—" : `${Math.round(wheel * 100)}%/notch`),
      kv("Lock-break grace", tuning?.lockDecayMult ? `${tuning.lockDecayMult}× drain` : "—"),
    );

    group.append(
      invert.el,
      note("Off means moving up raises the nose."),
      mouseSensitivity,
      touchSensitivity,
      note("These multiply the current theme's steering feel; 1.00× is the designer baseline."),
      bindings,
      list,
      note("The bindings are fixed in the MVP. Deadzone, throttle response, and lock timing remain designer-owned theme/tuning knobs."),
    );
    return group;
  }

  private rendererGroup(): HTMLElement {
    const group = settingsGroup("Renderer");
    const seg = document.createElement("div");
    seg.className = "sa-seg";
    seg.dataset["setting"] = "renderer";
    const options: { value: RendererPref; label: string }[] = [
      { value: "webgl", label: "WebGL2" },
      { value: "webgpu", label: "WebGPU" },
    ];
    const buttons = options.map(({ value, label }) => {
      const b = segButton(label, () => this.host.settings.set({ renderer: value }));
      b.dataset["renderer"] = value;
      seg.append(b);
      return { b, value };
    });
    this.refreshers.push((values) => {
      for (const { b, value } of buttons) b.setAttribute("aria-pressed", String(values.renderer === value));
    });

    const reload = document.createElement("button");
    reload.className = "sa-screen-btn sa-button sa-button--secondary";
    reload.dataset["settingsReload"] = "";
    reload.textContent = "Reload now";
    reload.addEventListener("click", () => (this.host.reload ?? (() => window.location.reload()))());

    group.append(
      seg,
      note("Requires a reload. WebGPU is experimental — it can present a black canvas on some GPUs; WebGL2 is the safe default."),
      reload,
    );
    return group;
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeFullscreen();
    this.fullscreenRefresh = null;
    this.refreshers.length = 0;
    this.root.remove();
  }
}

// --- Small DOM builders ---------------------------------------------------

function settingsGroup(title: string): HTMLDivElement {
  const group = document.createElement("div");
  group.className = "sa-settings-group";
  group.dataset["group"] = title.toLowerCase();
  const heading = document.createElement("h2");
  heading.textContent = title;
  group.append(heading);
  return group;
}

function settingsRow(label: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "sa-settings-row";
  const labelRow = document.createElement("div");
  labelRow.className = "label";
  const name = document.createElement("span");
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "value";
  labelRow.append(name, value);
  row.append(labelRow);
  return row;
}

function segButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sa-seg-btn";
  b.textContent = label;
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", onClick);
  return b;
}

function toggleButton(
  label: string,
  onToggle: (next: boolean) => void,
): { el: HTMLButtonElement; set: (on: boolean) => void } {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "sa-toggle";
  const text = document.createElement("span");
  text.textContent = label;
  const pill = document.createElement("span");
  pill.className = "pill";
  el.append(text, pill);
  const set = (on: boolean): void => {
    el.setAttribute("aria-pressed", String(on));
    pill.textContent = on ? "ON" : "OFF";
  };
  set(false);
  el.addEventListener("click", () => onToggle(el.getAttribute("aria-pressed") !== "true"));
  return { el, set };
}

function note(text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "sa-settings-note";
  el.textContent = text;
  return el;
}

function kv(key: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "kv";
  const k = document.createElement("span");
  k.textContent = key;
  const v = document.createElement("b");
  v.textContent = value;
  row.append(k, v);
  return row;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
