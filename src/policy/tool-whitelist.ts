import { isAbsolute, resolve } from "node:path";
import type { DejavuConfig } from "../config/load.js";
import { classifyBashCommand } from "./bash-classifier.js";

/** Static list of tools considered cacheable in v0.1. Bash gates further on classifier. */
export const SUPPORTED_TOOLS: ReadonlyArray<string> = ["Read", "Grep", "Glob", "Bash"];

/** Tools whose execution invalidates the Read cache for the affected file. */
export const INVALIDATING_TOOLS: ReadonlyArray<string> = ["Edit", "Write", "MultiEdit"];

export interface CacheabilityCheck {
  cacheable: boolean;
  reason: string;
  /** Files whose mtime should fold into the cache key. */
  mtimeFiles: string[];
  /** TTL bucket name (resolved against config). */
  ttlBucket: "read" | "grep" | "bash" | "none";
  /**
   * Subset of `tool_input` that is semantically meaningful for the cache key.
   * Cosmetic fields like `description` (added by Claude Code on each call)
   * MUST be excluded so two textually-different invocations of the same tool
   * with the same effective arguments collapse to the same key.
   */
  keyInput: Record<string, unknown>;
}

/**
 * Decide whether a tool invocation can hit the cache, and if so what to feed
 * into the key (mtime files) and which TTL bucket applies.
 */
export function classifyToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  cfg: DejavuConfig,
): CacheabilityCheck {
  if (!cfg.enabled) {
    return { cacheable: false, reason: "plugin disabled", mtimeFiles: [], ttlBucket: "none", keyInput: {} };
  }
  if (cfg.disabledTools.includes(toolName)) {
    return { cacheable: false, reason: "tool disabled in config", mtimeFiles: [], ttlBucket: "none", keyInput: {} };
  }

  switch (toolName) {
    case "Read": {
      const filePath = toolInput.file_path;
      if (typeof filePath !== "string" || !filePath) {
        return { cacheable: false, reason: "missing file_path", mtimeFiles: [], ttlBucket: "none", keyInput: {} };
      }
      const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
      return {
        cacheable: true,
        reason: "ok",
        mtimeFiles: [abs],
        ttlBucket: "read",
        keyInput: pickFields(toolInput, ["file_path", "offset", "limit"]),
      };
    }
    case "Grep": {
      return {
        cacheable: true,
        reason: "ok (TTL-only)",
        mtimeFiles: [],
        ttlBucket: "grep",
        keyInput: pickFields(toolInput, [
          "pattern", "path", "glob", "type", "output_mode",
          "head_limit", "multiline", "-i", "-n", "-A", "-B", "-C",
        ]),
      };
    }
    case "Glob": {
      return {
        cacheable: true,
        reason: "ok (TTL-only)",
        mtimeFiles: [],
        ttlBucket: "grep",
        keyInput: pickFields(toolInput, ["pattern", "path"]),
      };
    }
    case "Bash": {
      const command = typeof toolInput.command === "string" ? toolInput.command : "";
      const verdict = classifyBashCommand(command, {
        allow: cfg.bash.allow,
        deny:  cfg.bash.deny,
      });
      return {
        cacheable: verdict.cacheable,
        reason: verdict.reason,
        mtimeFiles: [],
        ttlBucket: verdict.cacheable ? "bash" : "none",
        // Only the actual command is semantic — `description`, `timeout`,
        // `run_in_background` and other UI metadata must NOT enter the key.
        keyInput: { command },
      };
    }
    default:
      return {
        cacheable: false,
        reason: `tool '${toolName}' not in supported set`,
        mtimeFiles: [],
        ttlBucket: "none",
        keyInput: {},
      };
  }
}

/**
 * Return a copy of {@code obj} containing only the named fields, in the order
 * given. Fields that are missing from {@code obj} are omitted from the output
 * so cache keys stay stable across Claude Code versions that add or rename
 * surrounding metadata.
 */
function pickFields(obj: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) {
      out[f] = obj[f];
    }
  }
  return out;
}

/**
 * If a tool invocation is a mutation that would invalidate Read cache entries,
 * extract the affected absolute path. Returns null when the tool is not
 * invalidating.
 */
export function extractInvalidationPath(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): string | null {
  if (!INVALIDATING_TOOLS.includes(toolName)) return null;
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || !filePath) return null;
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export function ttlForBucket(bucket: CacheabilityCheck["ttlBucket"], cfg: DejavuConfig): number {
  switch (bucket) {
    case "read": return cfg.ttl.read;
    case "grep": return cfg.ttl.grep;
    case "bash": return cfg.ttl.bash;
    case "none": return 0;
  }
}
