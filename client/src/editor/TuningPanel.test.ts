import { afterEach, describe, expect, it, vi } from "vitest";
import { tuningSchema, type ConfigService, type TuningConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import { TuningPanel } from "./TuningPanel.js";

afterEach(() => vi.unstubAllGlobals());

function tuning(): TuningConfig {
  return tuningSchema.parse({
    id: "tuning.default",
    type: "tuning",
    version: 1,
    targetingPolicy: "nearest",
    globalDamageMult: 1,
  });
}

describe("TuningPanel persistence feedback", () => {
  it("reports endpoint failures through the editor problem UI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("disk denied", { status: 400 })));
    const configService = {
      getAll: vi.fn((type: string) => (type === "tuning" ? [tuning()] : [])),
      replace: vi.fn(() => ({ ok: true as const, errors: [] })),
    } as unknown as ConfigService;
    const report = vi.fn();
    const panel = new TuningPanel({ configService } as unknown as EditorHost, report);

    panel.element.querySelector<HTMLButtonElement>(".ed-btn--primary")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(report).toHaveBeenCalledWith(expect.stringContaining("disk denied"));
    panel.dispose();
  });
});
