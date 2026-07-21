import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, resetGlobalLogLevel, setGlobalLogLevel, type LoggerSink } from "./Logger.js";

function makeSink(): LoggerSink & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("Logger", () => {
  beforeEach(() => {
    resetGlobalLogLevel();
  });

  afterEach(() => {
    resetGlobalLogLevel();
  });

  it("prefixes messages with the namespace", () => {
    setGlobalLogLevel("debug");
    const sink = makeSink();
    const logger = new Logger("Net", sink);

    logger.info("hello", 1);

    expect(sink.info).toHaveBeenCalledWith("[Net]", "hello", 1);
  });

  it("filters out levels below the configured global level", () => {
    setGlobalLogLevel("warn");
    const sink = makeSink();
    const logger = new Logger("Sim", sink);

    logger.debug("nope");
    logger.info("nope");
    logger.warn("yep");
    logger.error("yep");

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it("silent level suppresses everything", () => {
    setGlobalLogLevel("silent");
    const sink = makeSink();
    const logger = new Logger("X", sink);

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });

  it("defaults to info level when nothing overrides it", () => {
    const sink = makeSink();
    const logger = new Logger("Default", sink);

    logger.debug("suppressed");
    logger.info("shown");

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledTimes(1);
  });
});
