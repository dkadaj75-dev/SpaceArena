import type { ConfigError, ContentBundle } from "@space-arena/shared";

export interface EditorStatus {
  protocolVersion: number;
  pack: { packId: string; packVersion: number; sourceHash: string; files: number; rollbackAvailable: boolean };
}

export interface PublishResult {
  ok: true;
  packId: string;
  packVersion: number;
  sourceHash: string;
  files: number;
  rollbackAvailable: boolean;
}

export class EditorRepositoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly errors: ConfigError[] = []) {
    super(message);
  }
}

export interface EditorRepository {
  status(): Promise<EditorStatus>;
  load(): Promise<ContentBundle>;
  publish(bundle: ContentBundle, expectedSourceHash: string): Promise<PublishResult>;
  rollback(): Promise<PublishResult>;
}
