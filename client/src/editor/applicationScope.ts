import type { ConfigType } from "@space-arena/shared";

export type ApplicationScope = "live" | "partial" | "next-match";

export interface ApplicationPolicy {
  scope: ApplicationScope;
  message: string;
}

/**
 * Honest runtime scope for editor changes. Persistence is separate: every save
 * goes to disk immediately, while this describes an already-running match.
 */
export const APPLICATION_POLICY: Record<ConfigType, ApplicationPolicy> = {
  camera: { scope: "live", message: "Applies live to the camera." },
  theme: { scope: "live", message: "Applies live to the scene, audio, and HUD." },
  botprofile: { scope: "live", message: "Applies live at the bot's next decision." },
  action: { scope: "live", message: "Applies live when the next action is resolved." },
  notification: { scope: "live", message: "Applies live to newly shown notifications." },
  module: {
    scope: "partial",
    message: "Module behavior applies live; fitted ship base stats and attachments apply next match.",
  },
  effect: {
    scope: "partial",
    message: "New one-shot effects apply live; existing ship emitters apply next match.",
  },
  arena: {
    scope: "next-match",
    message: "Applies next match. The editor preview updates now; live simulation placements and rules stay coherent.",
  },
  asteroid: {
    scope: "next-match",
    message: "Applies next match. Existing asteroid physics and render instances are not rebuilt mid-match.",
  },
  ship: {
    scope: "next-match",
    message: "Applies next match. The editor preview updates now; spawned ships keep their resolved stats and rig.",
  },
  upgrade: { scope: "next-match", message: "Applies next match when ship stats are resolved." },
  tutorial: {
    scope: "next-match",
    message: "Applies the next time the tutorial is launched; a running one keeps the steps it started with.",
  },
  gamemode: { scope: "next-match", message: "Applies next match; win conditions and rosters are pinned at match start." },
  progression: {
    scope: "next-match",
    message: "Applies to the next server-created profile or rewarded match after server content reload.",
  },
  tuning: {
    scope: "partial",
    message: "Simulation tuning applies live offline; pool sizes and online prediction apply next match.",
  },
  quality: {
    scope: "partial",
    message: "Applies live except particle budgets on existing ship emitters, which apply next match.",
  },
  event: { scope: "next-match", message: "Applies next match." },
  cosmetic: {
    scope: "next-match",
    message: "Applies next match. Spawned ships keep the paint they were built with.",
  },
};

export function applicationNotice(type: ConfigType): HTMLParagraphElement {
  const policy = APPLICATION_POLICY[type];
  const element = document.createElement("p");
  element.className = `ed-apply-scope ed-apply-scope--${policy.scope}`;
  element.dataset.applyScope = policy.scope;
  element.textContent = policy.message;
  return element;
}
