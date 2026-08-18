import { CONFIG_SCHEMAS, type AnyConfig, type ConfigType } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { saveConfig } from "./saveConfig.js";
import { APPLICATION_POLICY } from "./applicationScope.js";

const MAX_LOG_LINES = 150;
const CONFIG_TYPE_NAMES = Object.keys(CONFIG_SCHEMAS) as ConfigType[];

const HELP = [
  "Commands:",
  "  ls <type>                list config ids of a type",
  "  get <id> [path]          print a config (or a sub-path) as JSON",
  "  set <id> <path> <value>  set a value (JSON, falls back to a raw string)",
  "  help                     this text",
  "",
  `Types: ${CONFIG_TYPE_NAMES.join(", ")}`,
  "Paths are dotted, e.g. `core.cooling.multiplier` or `hardpoints.0.name`.",
  "History: Up / Down arrows.",
].join("\n");

type LineKind = "out" | "cmd" | "err" | "info";

/**
 * Command line + scrollback over the config registry (`ls` / `get` / `set`).
 *
 * `set` validates against the config type's schema before applying, then goes
 * through the exact path SchemaFormGen uses: `configService.replace()` for the
 * in-memory registry + `config:changed` bus event, followed by `saveConfig()`
 * so the change lands on disk and the Vite content watcher hot-reloads it.
 */
export class ConsolePanel implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly log = document.createElement("div");
  private readonly input = document.createElement("input");
  private readonly history: string[] = [];
  private historyIndex = 0;

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.element.className = "ed-console";
    this.log.className = "ed-console-log";

    const form = document.createElement("form");
    form.className = "ed-console-form";
    const prompt = document.createElement("span");
    prompt.className = "ed-console-prompt";
    prompt.textContent = ">";
    this.input.type = "text";
    this.input.className = "ed-console-input";
    this.input.placeholder = "help";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    form.append(prompt, this.input);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const line = this.input.value.trim();
      this.input.value = "";
      if (line) this.run(line);
    });
    this.input.addEventListener("keydown", (event) => this.onKey(event));

    this.element.append(this.log, form);
    this.print(HELP, "info");
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!this.history.length) return;
    event.preventDefault();
    this.historyIndex = event.key === "ArrowUp"
      ? Math.max(0, this.historyIndex - 1)
      : Math.min(this.history.length, this.historyIndex + 1);
    this.input.value = this.history[this.historyIndex] ?? "";
  }

  /** Runs one command line. Exposed for tests and for scripted dev flows. */
  run(line: string): void {
    this.history.push(line);
    this.historyIndex = this.history.length;
    this.print(`> ${line}`, "cmd");
    const [command, ...args] = line.split(/\s+/);
    try {
      switch (command) {
        case "help": this.print(HELP, "info"); break;
        case "ls": this.cmdLs(args); break;
        case "get": this.cmdGet(args); break;
        case "set": void this.cmdSet(args); break;
        default: this.print(`Unknown command: ${command}. Try \`help\`.`, "err");
      }
    } catch (error) {
      this.print(String(error), "err");
    }
  }

  private cmdLs(args: string[]): void {
    const type = args[0];
    if (!type) { this.print(`Usage: ls <type>. Types: ${CONFIG_TYPE_NAMES.join(", ")}`, "err"); return; }
    if (!isConfigType(type)) { this.print(`Unknown type "${type}". Types: ${CONFIG_TYPE_NAMES.join(", ")}`, "err"); return; }
    const ids = this.host.configService.getAll(type).map((config) => config.id).sort();
    this.print(ids.length ? ids.join("\n") : `(no ${type} configs loaded)`);
  }

  private cmdGet(args: string[]): void {
    const [id, path] = args;
    if (!id) { this.print("Usage: get <id> [path]", "err"); return; }
    const found = this.find(id);
    if (!found) { this.print(`No config with id "${id}".`, "err"); return; }
    const value = path ? readPath(found.config, splitPath(path)) : found.config;
    if (value === undefined) { this.print(`No value at "${path}" in ${id}.`, "err"); return; }
    this.print(JSON.stringify(value, null, 2));
  }

  private async cmdSet(args: string[]): Promise<void> {
    const [id, path, ...rest] = args;
    if (!id || !path || !rest.length) { this.print("Usage: set <id> <path> <value>", "err"); return; }
    const found = this.find(id);
    if (!found) { this.print(`No config with id "${id}".`, "err"); return; }

    const raw = rest.join(" ");
    let next: unknown;
    try { next = JSON.parse(raw); } catch { next = raw; }

    const candidate = structuredClone(found.config) as Record<string, unknown>;
    const segments = splitPath(path);
    if (!writePath(candidate, segments, next)) { this.print(`Cannot write "${path}" — a parent segment is missing.`, "err"); return; }

    const parsed = CONFIG_SCHEMAS[found.type].safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) this.print(`${issue.path.join(".") || "(root)"}: ${issue.message}`, "err");
      this.report(`${id} ${path}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
      return;
    }

    const replaced = this.host.configService.replace(parsed.data);
    if (!replaced.ok) {
      for (const error of replaced.errors) this.print(`${error.path}: ${error.message}`, "err");
      this.report(replaced.errors.map((e) => e.message).join("; "));
      return;
    }

    this.print(`${id}.${path} = ${JSON.stringify(readPath(parsed.data, segments))}`, "info");
    this.print(APPLICATION_POLICY[found.type].message, "info");
    const error = await saveConfig(parsed.data as AnyConfig);
    if (error) { this.print(error, "err"); this.report(error); }
    else this.print("saved to disk", "info");
  }

  /** Config ids are globally unique, so a scan across types is enough. */
  private find(id: string): { type: ConfigType; config: AnyConfig } | null {
    for (const type of CONFIG_TYPE_NAMES) {
      const config = this.host.configService.get(type, id);
      if (config) return { type, config };
    }
    return null;
  }

  private print(message: string, kind: LineKind = "out"): void {
    const row = document.createElement("p");
    row.className = `ed-console-entry ed-console-entry--${kind}`;
    row.textContent = message;
    this.log.append(row);
    while (this.log.childElementCount > MAX_LOG_LINES) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  dispose(): void {
    this.element.replaceChildren();
  }
}

function isConfigType(value: string): value is ConfigType {
  return value in CONFIG_SCHEMAS;
}

function splitPath(path: string): string[] {
  return path.split(".").filter((part) => part.length > 0);
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Assigns `next` at `path`. Returns false when an intermediate node is missing. */
function writePath(target: Record<string, unknown>, path: string[], next: unknown): boolean {
  if (!path.length) return false;
  let current: unknown = target;
  for (const key of path.slice(0, -1)) {
    if (current === null || typeof current !== "object") return false;
    current = Array.isArray(current) ? current[Number(key)] : (current as Record<string, unknown>)[key];
  }
  if (current === null || typeof current !== "object") return false;
  const last = path[path.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = next;
  else (current as Record<string, unknown>)[last] = next;
  return true;
}
