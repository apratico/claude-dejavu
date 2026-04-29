/**
 * `claude-dejavu` CLI — invoked by the `/dejavu` slash command via the Bash
 * tool. Renders plain-text output for the user (no JSON, no log noise on
 * stdout — pino logs go to a file).
 *
 * Subcommands:
 *   stats               — hit rate, byte usage, per-tool breakdown
 *   clear [--tool X]    — drop the entire cache, or only X's entries
 *   why <hash>          — show the cached entry for a key prefix
 *   --help              — usage
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { CacheStore } from "./cache/store.js";

const dbPath = join(
  process.env.CLAUDE_DEJAVU_HOME ?? join(homedir(), ".claude-dejavu"),
  "cache.db",
);

const args = process.argv.slice(2);
const cmd = args[0] ?? "--help";

switch (cmd) {
  case "stats":      runStats(); break;
  case "clear":      runClear(args.slice(1)); break;
  case "why":        runWhy(args[1]); break;
  case "--help":
  case "-h":
  case "help":       printUsage(); break;
  default:
    console.error(`unknown subcommand: ${cmd}`);
    printUsage();
    process.exit(1);
}

function runStats(): void {
  const store = new CacheStore(dbPath);
  try {
    const s = store.stats();
    const lines: string[] = [];
    lines.push("claude-dejavu — cache statistics");
    lines.push("");
    lines.push(`  total entries : ${s.totalRows}`);
    lines.push(`  total size    : ${formatBytes(s.totalBytes)}`);
    lines.push("");
    if (s.perTool.length === 0) {
      lines.push("  (no entries yet)");
    } else {
      const totalHits = s.perTool.reduce((acc, t) => acc + t.hits, 0);
      lines.push("  per-tool breakdown:");
      lines.push("    tool        rows    hits    bytes");
      for (const t of s.perTool) {
        lines.push(
          "    " +
            t.toolName.padEnd(12) +
            String(t.rows).padStart(4) +
            "    " +
            String(t.hits).padStart(4) +
            "    " +
            formatBytes(t.bytes),
        );
      }
      lines.push("");
      lines.push(`  total cache hits served : ${totalHits}`);
    }
    console.log(lines.join("\n"));
  } finally {
    store.close();
  }
}

function runClear(rest: string[]): void {
  const store = new CacheStore(dbPath);
  try {
    const toolIdx = rest.indexOf("--tool");
    if (toolIdx >= 0) {
      const toolName = rest[toolIdx + 1];
      if (!toolName) {
        console.error("--tool requires an argument (e.g. --tool Read)");
        process.exit(1);
      }
      const dropped = store.invalidateByTool(toolName);
      console.log(`claude-dejavu: removed ${dropped} entr${dropped === 1 ? "y" : "ies"} for ${toolName}`);
      return;
    }
    const dropped = store.invalidateAll();
    console.log(`claude-dejavu: removed ${dropped} entr${dropped === 1 ? "y" : "ies"} (full wipe)`);
  } finally {
    store.close();
  }
}

function runWhy(hashPrefix: string | undefined): void {
  if (!hashPrefix) {
    console.error("/dejavu why requires a hash (full or prefix)");
    process.exit(1);
  }
  const store = new CacheStore(dbPath);
  try {
    if (hashPrefix.length === 64) {
      const entry = store.get(hashPrefix);
      if (!entry) {
        console.log(`claude-dejavu: no entry with hash ${hashPrefix}`);
        return;
      }
      console.log(formatEntry(entry));
      return;
    }
    // Prefix match — surface up to 3 candidates
    const all = store.stats().perTool;
    void all;
    console.log(
      `claude-dejavu: prefix lookup not implemented for short hashes yet; pass the full 64-char hash from the cache hit message.`,
    );
  } finally {
    store.close();
  }
}

function formatEntry(entry: {
  hash: string; toolName: string; toolInputJson: string;
  sizeBytes: number; createdAt: number; lastUsedAt: number; expiresAt: number; hits: number;
}): string {
  const ttl = entry.expiresAt === 0
    ? "(no TTL — mtime-based)"
    : `${entry.expiresAt - Math.floor(Date.now() / 1000)}s remaining`;
  return [
    `hash       : ${entry.hash}`,
    `tool       : ${entry.toolName}`,
    `tool_input : ${entry.toolInputJson}`,
    `size       : ${formatBytes(entry.sizeBytes)}`,
    `created    : ${new Date(entry.createdAt * 1000).toISOString()}`,
    `last_used  : ${new Date(entry.lastUsedAt * 1000).toISOString()}`,
    `ttl        : ${ttl}`,
    `hits       : ${entry.hits}`,
  ].join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function printUsage(): void {
  console.log(
    [
      "claude-dejavu — cache control",
      "",
      "Usage:",
      "  /dejavu stats                       Show cache hit / size / per-tool stats",
      "  /dejavu clear                       Drop every cached entry",
      "  /dejavu clear --tool <ToolName>     Drop entries for one tool",
      "  /dejavu why <hash>                  Inspect a single cache entry",
      "",
      "Data directory:",
      "  $CLAUDE_DEJAVU_HOME, defaults to ~/.claude-dejavu/",
    ].join("\n"),
  );
}
