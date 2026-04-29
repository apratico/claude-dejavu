import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DejavuConfig {
  enabled: boolean;
  ttl: {
    /** TTL for Bash-whitelist entries, in seconds. */
    bash: number;
    /** TTL for Read entries, in seconds. 0 = unbounded (mtime-only). */
    read: number;
    /** TTL for Grep/Glob entries, in seconds. */
    grep: number;
  };
  bash: {
    /** Extra commands to add to the read-only whitelist (first-word match). */
    allow: string[];
    /** Commands to never cache (overrides whitelist). */
    deny: string[];
  };
  /** Tool names to skip the cache for entirely. */
  disabledTools: string[];
  /** Hard cap on total cache rows; LRU-evicted beyond. */
  maxRows: number;
  /** Hard cap on bytes stored per cache row (response value). */
  maxValueBytes: number;
}

export const DEFAULT_CONFIG: DejavuConfig = {
  enabled: true,
  ttl: {
    bash: 60 * 60,    // 1h
    read: 0,          // mtime-based, unbounded otherwise
    grep: 5 * 60,     // 5m
  },
  bash: {
    allow: [],
    deny: [],
  },
  disabledTools: [],
  maxRows: 50_000,
  maxValueBytes: 256 * 1024,  // 256 KB per entry
};

function configPath(): string {
  if (process.env.CLAUDE_DEJAVU_CONFIG) return process.env.CLAUDE_DEJAVU_CONFIG;
  const home = process.env.CLAUDE_DEJAVU_HOME ?? join(homedir(), ".claude-dejavu");
  return join(home, "config.json");
}

/**
 * Load user config from disk and shallow-merge it with the defaults. Missing
 * file or unparseable JSON falls back silently to defaults — a hot-path hook
 * cannot afford to crash on malformed user config.
 */
export function loadConfig(path: string = configPath()): DejavuConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DejavuConfig>;
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function mergeConfig(base: DejavuConfig, override: Partial<DejavuConfig>): DejavuConfig {
  return {
    enabled: override.enabled ?? base.enabled,
    ttl: { ...base.ttl, ...(override.ttl ?? {}) },
    bash: {
      allow: dedupe([...base.bash.allow, ...(override.bash?.allow ?? [])]),
      deny:  dedupe([...base.bash.deny,  ...(override.bash?.deny  ?? [])]),
    },
    disabledTools: dedupe([...base.disabledTools, ...(override.disabledTools ?? [])]),
    maxRows: override.maxRows ?? base.maxRows,
    maxValueBytes: override.maxValueBytes ?? base.maxValueBytes,
  };
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
