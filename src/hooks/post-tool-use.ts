/**
 * PostToolUse hook. Two responsibilities:
 *
 *   1. **Populate the cache** for cacheable tool calls (Read / Grep / Glob /
 *      Bash whitelist). Same key derivation as PreToolUse so the next
 *      identical call hits.
 *
 *   2. **Invalidate Read cache entries** for any file mutated by Edit / Write
 *      / MultiEdit, so a subsequent Read sees the fresh contents.
 *
 * PostToolUse cannot mutate the tool output Claude sees — it is observation
 * only. We always emit an empty `hookSpecificOutput` and exit zero.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { CacheStore } from "../cache/store.js";
import { buildKey } from "../cache/key.js";
import { loadConfig } from "../config/load.js";
import {
  classifyToolCall,
  extractInvalidationPath,
  ttlForBucket,
} from "../policy/tool-whitelist.js";
import { readJsonStdin, writeJsonStdout, type PostToolUseInput } from "./io.js";
import { log, withErrorLogging } from "../log.js";

void withErrorLogging("post-tool-use", async () => {
  let input: PostToolUseInput;
  try {
    input = await readJsonStdin<PostToolUseInput>();
  } catch (err) {
    log.warn({ err: String(err) }, "post-tool-use: stdin parse failed; emitting empty response");
    writeJsonStdout({});
    return;
  }

  const cfg = loadConfig();
  const dbPath = join(
    process.env.CLAUDE_DEJAVU_HOME ?? join(homedir(), ".claude-dejavu"),
    "cache.db",
  );
  const store = new CacheStore(dbPath, { maxRows: cfg.maxRows });

  try {
    // Invalidation path first — even if the tool isn't cacheable.
    const invalidatedPath = extractInvalidationPath(
      input.tool_name,
      input.tool_input,
      input.cwd,
    );
    if (invalidatedPath) {
      const dropped = store.invalidateReadsForPath(invalidatedPath);
      log.info({ tool: input.tool_name, path: invalidatedPath, dropped }, "post: invalidated reads");
    }

    const verdict = classifyToolCall(input.tool_name, input.tool_input, input.cwd, cfg);
    if (!verdict.cacheable) {
      writeJsonStdout({});
      return;
    }

    const value = extractCacheableValue(input);
    if (value === null) {
      log.debug({ tool: input.tool_name }, "post: no value to cache");
      writeJsonStdout({});
      return;
    }
    if (Buffer.byteLength(value, "utf8") > cfg.maxValueBytes) {
      log.info({ tool: input.tool_name, sizeBytes: value.length }, "post: value exceeds cap, skipping");
      writeJsonStdout({});
      return;
    }

    const { hash } = buildKey({
      toolName: input.tool_name,
      toolInput: verdict.keyInput,
      cwd: input.cwd,
      mtimeFiles: verdict.mtimeFiles,
    });
    store.put(hash, input.tool_name, value, {
      ttlSeconds: ttlForBucket(verdict.ttlBucket, cfg),
      toolInputJson: JSON.stringify(verdict.keyInput),
    });
    log.info({ tool: input.tool_name, hash, sizeBytes: value.length }, "post: cached");

    writeJsonStdout({});
  } finally {
    store.close();
  }
});

/**
 * Pull a string-shaped result out of the PostToolUse payload. Different
 * Claude Code versions deliver the tool output under different keys; we accept
 * `tool_output` and `tool_response`. Within either, prefer the `text` field
 * if present; fall back to JSON.stringify of the whole object.
 */
function extractCacheableValue(input: PostToolUseInput): string | null {
  const candidate = input.tool_output ?? input.tool_response;
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "object") {
    const obj = candidate as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.content === "string") return obj.content;
    return JSON.stringify(candidate);
  }
  return String(candidate);
}
