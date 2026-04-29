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
    return { cacheable: false, reason: "plugin disabled", mtimeFiles: [], ttlBucket: "none" };
  }
  if (cfg.disabledTools.includes(toolName)) {
    return { cacheable: false, reason: "tool disabled in config", mtimeFiles: [], ttlBucket: "none" };
  }

  switch (toolName) {
    case "Read": {
      const filePath = toolInput.file_path;
      if (typeof filePath !== "string" || !filePath) {
        return { cacheable: false, reason: "missing file_path", mtimeFiles: [], ttlBucket: "none" };
      }
      const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
      return { cacheable: true, reason: "ok", mtimeFiles: [abs], ttlBucket: "read" };
    }
    case "Grep":
    case "Glob": {
      // We don't track per-file mtime for Grep/Glob — too expensive at lookup.
      // Falls back to a short TTL bucket. See docs/architecture.md.
      return { cacheable: true, reason: "ok (TTL-only)", mtimeFiles: [], ttlBucket: "grep" };
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
      };
    }
    default:
      return {
        cacheable: false,
        reason: `tool '${toolName}' not in supported set`,
        mtimeFiles: [],
        ttlBucket: "none",
      };
  }
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
