import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../../core/AuthService.js";
import { AdminContentRepository } from "./AdminContentRepository.js";

describe("AdminContentRepository", () => {
  it("uses authenticated refresh-aware API calls for every overlay endpoint", async () => {
    const api = vi.fn(async (_method: string, path: string) => path.endsWith("status") ? { protocolVersion: 1, pack: { sourceHash: "hash", packId: "p", packVersion: 1, files: 1, rollbackAvailable: true } } : { ok: true });
    const repo = new AdminContentRepository({ api } as unknown as AuthService);
    await repo.status(); await repo.load(); await repo.rollback();
    expect(api.mock.calls.map((call) => call[1])).toEqual(["/api/admin/content/status", "/api/admin/content/export", "/api/admin/content/rollback"]);
  });

  it("refuses a stale publish before calling import", async () => {
    const api = vi.fn(async () => ({ protocolVersion: 1, pack: { sourceHash: "new" } }));
    const repo = new AdminContentRepository({ api } as unknown as AuthService);
    await expect(repo.publish({} as never, "old")).rejects.toMatchObject({ status: 409, code: "stale-content-pack" });
    expect(api).toHaveBeenCalledTimes(1);
  });
});
