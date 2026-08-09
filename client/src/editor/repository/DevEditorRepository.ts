// Phase 0 intentionally uses the same atomic admin pack API in development.
// This named adapter keeps environment selection explicit and leaves the old
// per-file Vite endpoint available only to legacy bespoke panels.
export { AdminContentRepository as DevEditorRepository } from "./AdminContentRepository.js";
