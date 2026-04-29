import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Logical inputs that produce a cache key. The hashing is deterministic given
 * the same inputs; mtime is included so file changes invalidate naturally.
 */
export interface KeyContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  /**
   * File paths whose mtime should be folded into the key. The cache layer
   * expands this list per tool (e.g. for Read, [file_path]; for Bash whitelist,
   * empty by default since the command output isn't typically file-bound).
   */
  mtimeFiles: string[];
}

export interface KeyResult {
  /** SHA-256 hex digest, 64 chars. */
  hash: string;
  /** Normalized canonical inputs that fed the hash — useful for `/dejavu why`. */
  canonical: {
    toolName: string;
    toolInput: Record<string, unknown>;
    cwd: string;
    mtimes: Array<{ path: string; mtimeNs: string | null }>;
  };
}

/**
 * Build a deterministic cache key for a given tool invocation.
 *
 * Normalization rules:
 *   - tool name: untouched (exact match required)
 *   - tool input: object keys sorted, values JSON.stringified deterministically
 *   - cwd: resolved to an absolute path
 *   - mtimeFiles: each path resolved against cwd, mtime-ns appended; missing
 *     files contribute the literal token "(absent)" so re-creating the file
 *     produces a different hash than first run.
 */
export function buildKey(ctx: KeyContext): KeyResult {
  const cwd = resolve(ctx.cwd);
  const normalizedInput = canonicalizeJson(ctx.toolInput) as Record<string, unknown>;
  const mtimes = ctx.mtimeFiles
    .map((p) => (isAbsolute(p) ? p : resolve(cwd, p)))
    .sort()
    .map((path) => ({ path, mtimeNs: readMtimeNs(path) }));

  const canonical = {
    toolName: ctx.toolName,
    toolInput: normalizedInput,
    cwd,
    mtimes,
  };

  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { hash, canonical };
}

function readMtimeNs(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return statSync(path, { bigint: true }).mtimeNs.toString();
  } catch {
    return null;
  }
}

/**
 * Recursively sort object keys so JSON.stringify output is deterministic.
 * Arrays preserve order — order is semantic for tool args (e.g. argv lists).
 */
export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalizeJson(obj[k]);
  }
  return sorted;
}
