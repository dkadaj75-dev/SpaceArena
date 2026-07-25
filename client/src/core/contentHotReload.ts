import { createLogger, manifestSchema, type ConfigService } from "@space-arena/shared";

const log = createLogger("HotReload");

interface ContentChanged {
  file: string;
  json: unknown;
}
interface ContentError {
  file: string;
  message: string;
}

/**
 * Subscribe to the dev content pipeline (see client/vite.config.ts). On every
 * saved content file we call ConfigService.replace() and log the outcome loudly.
 * Invalid JSON or schema/reference errors are reported but never crash the app.
 */
export function wireContentHotReload(configService: ConfigService): void {
  if (!import.meta.hot) return;

  import.meta.hot.on("content:changed", (data: ContentChanged) => {
    // The manifest is not a config (its "manifest" type is deliberately absent
    // from CONFIG_SCHEMAS — ConfigService.load() validates it separately), so
    // replace() would reject it with a misleading red error on every edit.
    // New/removed files only take effect on a full content load anyway.
    if (data.file === "manifest.json") {
      const parsed = manifestSchema.safeParse(data.json);
      if (parsed.success) {
        log.info("manifest changed — reload the page to pick up added/removed content files");
      } else {
        log.error(`✖ invalid manifest.json: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      }
      return;
    }
    const result = configService.replace(data.json);
    if (result.ok) {
      log.info(`hot-reloaded ${data.file}`);
    } else {
      log.error(`✖ rejected ${data.file} (${result.errors.length} problem(s)):`);
      for (const e of result.errors) {
        log.error(`    ${e.path || "(root)"}: ${e.message}`);
      }
    }
  });

  import.meta.hot.on("content:error", (data: ContentError) => {
    log.error(`✖ invalid JSON in ${data.file}: ${data.message}`);
  });

  log.info("content hot-reload wired");
}
