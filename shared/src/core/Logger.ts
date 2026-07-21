/**
 * Namespaced logger with level filtering.
 *
 * Level is resolved once (lazily, on first use) from:
 *  - Client (browser): `?log=debug` URL query flag.
 *  - Server (node): `LOG` environment variable.
 * Defaults to "info" if neither is present or parsing fails.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function isLogLevel(value: string | null | undefined): value is LogLevel {
  return !!value && (LOG_LEVELS as readonly string[]).includes(value);
}

function detectLevel(): LogLevel {
  // Client: read `?log=` from the current URL, if a DOM/location is present.
  if (typeof globalThis !== "undefined") {
    const loc = (globalThis as { location?: { search?: string } }).location;
    if (loc?.search) {
      try {
        const params = new URLSearchParams(loc.search);
        const flag = params.get("log");
        if (isLogLevel(flag)) return flag;
      } catch {
        // ignore malformed query strings
      }
    }
  }

  // Server: read `LOG` env var, if process.env is present.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const envLevel = env?.LOG;
  if (isLogLevel(envLevel)) return envLevel;

  return "info";
}

let cachedLevel: LogLevel | null = null;

function getGlobalLevel(): LogLevel {
  if (cachedLevel === null) {
    cachedLevel = detectLevel();
  }
  return cachedLevel;
}

/** Override the resolved global level (mainly for tests). */
export function setGlobalLogLevel(level: LogLevel): void {
  cachedLevel = level;
}

/** Force re-detection of the level from URL/env on next use. */
export function resetGlobalLogLevel(): void {
  cachedLevel = null;
}

export interface LoggerSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const consoleSink: LoggerSink = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

export class Logger {
  constructor(
    private readonly namespace: string,
    private readonly sink: LoggerSink = consoleSink,
  ) {}

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[getGlobalLevel()];
  }

  private prefix(): string {
    return `[${this.namespace}]`;
  }

  debug(...args: unknown[]): void {
    if (this.enabled("debug")) this.sink.debug(this.prefix(), ...args);
  }

  info(...args: unknown[]): void {
    if (this.enabled("info")) this.sink.info(this.prefix(), ...args);
  }

  warn(...args: unknown[]): void {
    if (this.enabled("warn")) this.sink.warn(this.prefix(), ...args);
  }

  error(...args: unknown[]): void {
    if (this.enabled("error")) this.sink.error(this.prefix(), ...args);
  }
}

export function createLogger(namespace: string, sink?: LoggerSink): Logger {
  return new Logger(namespace, sink);
}
