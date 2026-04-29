/**
 * PreToolUse hook. Routes tool calls through the cache:
 *   - cache hit  → deny with `additionalContext` carrying the cached payload
 *                  (Claude reads it as if it were the tool's result; the tool
 *                  itself never executes — latency, FS I/O and token churn
 *                  on the next reasoning step are saved).
 *   - cache miss → allow normally, leaving PostToolUse to populate the cache.
 *
 * The hook fails open: any error path emits an `allow` response so the user's
 * session is never broken by a misbehaving cache.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { CacheStore } from "../cache/store.js";
import { buildKey } from "../cache/key.js";
import { loadConfig } from "../config/load.js";
import { classifyToolCall, ttlForBucket } from "../policy/tool-whitelist.js";
import {
  allowPre,
  denyPreWithCachedContext,
  readJsonStdin,
  writeJsonStdout,
  type PreToolUseInput,
} from "./io.js";
import { log, withErrorLogging } from "../log.js";

const CACHE_MARKER = "[claude-dejavu CACHE_HIT]";

void withErrorLogging("pre-tool-use", async () => {
  let input: PreToolUseInput;
  try {
    input = await readJsonStdin<PreToolUseInput>();
  } catch (err) {
    log.warn({ err: String(err) }, "pre-tool-use: stdin parse failed; falling back to allow");
    writeJsonStdout(allowPre());
    return;
  }

  const cfg = loadConfig();
  const verdict = classifyToolCall(input.tool_name, input.tool_input, input.cwd, cfg);
  if (!verdict.cacheable) {
    log.debug({ tool: input.tool_name, reason: verdict.reason }, "pre: not cacheable, allow");
    writeJsonStdout(allowPre());
    return;
  }

  const dbPath = join(
    process.env.CLAUDE_DEJAVU_HOME ?? join(homedir(), ".claude-dejavu"),
    "cache.db",
  );
  const store = new CacheStore(dbPath, { maxRows: cfg.maxRows });

  try {
    const { hash } = buildKey({
      toolName: input.tool_name,
      toolInput: verdict.keyInput,
      cwd: input.cwd,
      mtimeFiles: verdict.mtimeFiles,
    });
    const entry = store.get(hash);
    if (entry) {
      const ttl = ttlForBucket(verdict.ttlBucket, cfg);
      log.info(
        { tool: input.tool_name, hash, hits: entry.hits, sizeBytes: entry.sizeBytes, ttl },
        "pre: cache HIT",
      );
      writeJsonStdout(
        denyPreWithCachedContext(
          `claude-dejavu cache hit (key=${hash.slice(0, 12)})`,
          formatCachedContext(input.tool_name, hash, entry.value),
        ),
      );
      return;
    }
    log.info({ tool: input.tool_name, hash }, "pre: cache MISS, allowing");
    writeJsonStdout(allowPre());
  } finally {
    store.close();
  }
});

/**
 * Format the cached payload as the `additionalContext` Claude will see when
 * the tool call is denied. The marker line lets Claude (and humans reading
 * the transcript) recognise this is a cache replay rather than an arbitrary
 * note from the hook.
 */
function formatCachedContext(toolName: string, hash: string, value: string): string {
  return [
    `${CACHE_MARKER} tool=${toolName} key=${hash.slice(0, 12)}`,
    "The tool was not re-executed — claude-dejavu replayed the result of a prior identical call.",
    "If the underlying state has changed unexpectedly, re-run with `/dejavu clear` and try again.",
    "",
    "--- result begin ---",
    value,
    "--- result end ---",
  ].join("\n");
}
