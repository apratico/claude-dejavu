import { mkdirSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

const dataDir = process.env.CLAUDE_DEJAVU_HOME ?? join(homedir(), ".claude-dejavu");
const logDir = join(dataDir, "logs");
mkdirSync(logDir, { recursive: true });

const logFile = join(logDir, "dejavu.log");
const stream = createWriteStream(logFile, { flags: "a" });

export const log: Logger = pino(
  {
    level: process.env.CLAUDE_DEJAVU_LOG_LEVEL ?? "info",
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  stream,
);

/**
 * Wraps a hook execution so any exception is logged, never thrown to the
 * Claude Code runtime. A throwing hook would block the tool with a
 * non-zero exit code and confuse the user — better to fail open.
 */
export async function withErrorLogging(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error({ hook: name, err: serializeError(err) }, "hook crashed");
  }
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}
