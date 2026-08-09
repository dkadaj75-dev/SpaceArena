import type { ContentBundle } from "@space-arena/shared";
import type { AuthService } from "../../core/AuthService.js";
import { AdminContentApi } from "./AdminContentApi.js";
import { EditorRepositoryError, type EditorRepository, type EditorStatus, type PublishResult } from "./EditorRepository.js";

export class AdminContentRepository implements EditorRepository {
  private readonly api: AdminContentApi;
  constructor(auth: AuthService) { this.api = new AdminContentApi(auth); }
  status(): Promise<EditorStatus> { return this.api.request("GET", "/status"); }
  load(): Promise<ContentBundle> { return this.api.request("GET", "/export"); }
  async publish(bundle: ContentBundle, expectedSourceHash: string): Promise<PublishResult> {
    const current = await this.status();
    if (current.pack.sourceHash !== expectedSourceHash) {
      throw new EditorRepositoryError(409, "stale-content-pack", "The live pack changed since this draft was opened. Download your draft, then reload before publishing.");
    }
    return this.api.request("POST", "/import", bundle);
  }
  rollback(): Promise<PublishResult> { return this.api.request("POST", "/rollback"); }
}
