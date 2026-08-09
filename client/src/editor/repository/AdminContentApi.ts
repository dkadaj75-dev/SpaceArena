import type { ConfigError } from "@space-arena/shared";
import type { AuthService } from "../../core/AuthService.js";
import { EditorRepositoryError } from "./EditorRepository.js";

interface ErrorEnvelope { error?: { code?: string; message?: string }; errors?: ConfigError[] }

export class AdminContentApi {
  constructor(private readonly auth: AuthService) {}

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    try {
      return await this.auth.api<T>(method, `/api/admin/content${path}`, body);
    } catch (error) {
      const candidate = error as { status?: number; code?: string; message?: string; details?: ConfigError[] };
      throw new EditorRepositoryError(candidate.status ?? 0, candidate.code ?? "request-failed", candidate.message ?? "Request failed", Array.isArray(candidate.details) ? candidate.details : []);
    }
  }

  static async decodeError(response: Response): Promise<EditorRepositoryError> {
    const body = await response.json().catch(() => ({})) as ErrorEnvelope;
    return new EditorRepositoryError(response.status, body.error?.code ?? "request-failed", body.error?.message ?? response.statusText, body.errors ?? []);
  }
}
