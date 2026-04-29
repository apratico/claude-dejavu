"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/cli.ts
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");

// src/cache/store.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var SCHEMA_VERSION = 1;
var CacheStore = class {
  db;
  maxRows;
  stmts;
  constructor(dbPath2, opts = {}) {
    (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(dbPath2), { recursive: true });
    this.db = new import_better_sqlite3.default(dbPath2);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.maxRows = opts.maxRows ?? 5e4;
    this.migrate();
    this.stmts = {
      get: this.db.prepare(
        `SELECT hash, tool_name AS toolName, tool_input_json AS toolInputJson,
                value, size_bytes AS sizeBytes,
                created_at AS createdAt, last_used_at AS lastUsedAt,
                expires_at AS expiresAt, hits
           FROM cache WHERE hash = ?`
      ),
      upsert: this.db.prepare(
        `INSERT INTO cache (hash, tool_name, tool_input_json, value, size_bytes,
                            created_at, last_used_at, expires_at, hits)
         VALUES (@hash, @toolName, @toolInputJson, @value, @sizeBytes,
                 @createdAt, @lastUsedAt, @expiresAt, 0)
         ON CONFLICT(hash) DO UPDATE SET
           tool_name = excluded.tool_name,
           tool_input_json = excluded.tool_input_json,
           value = excluded.value,
           size_bytes = excluded.size_bytes,
           expires_at = excluded.expires_at,
           last_used_at = excluded.last_used_at`
      ),
      touch: this.db.prepare(
        `UPDATE cache SET last_used_at = ?, hits = hits + 1 WHERE hash = ?`
      ),
      deleteByHash: this.db.prepare(`DELETE FROM cache WHERE hash = ?`),
      deleteByTool: this.db.prepare(`DELETE FROM cache WHERE tool_name = ?`),
      deleteAll: this.db.prepare(`DELETE FROM cache`),
      countAll: this.db.prepare(`SELECT COUNT(*) AS c FROM cache`),
      sumSize: this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS b FROM cache`),
      statsByTool: this.db.prepare(
        `SELECT tool_name AS toolName, COUNT(*) AS rows, SUM(hits) AS hits, SUM(size_bytes) AS bytes
           FROM cache GROUP BY tool_name ORDER BY rows DESC`
      ),
      deleteOldest: this.db.prepare(
        `DELETE FROM cache WHERE hash IN (
           SELECT hash FROM cache ORDER BY last_used_at ASC LIMIT ?
         )`
      ),
      deleteForReadPath: this.db.prepare(
        `DELETE FROM cache WHERE tool_name = 'Read' AND tool_input_json LIKE ?`
      )
    };
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cache (
        hash             TEXT PRIMARY KEY,
        tool_name        TEXT NOT NULL,
        tool_input_json  TEXT NOT NULL,
        value            TEXT NOT NULL,
        size_bytes       INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        last_used_at     INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        hits             INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cache_lru       ON cache(last_used_at);
      CREATE INDEX IF NOT EXISTS idx_cache_tool      ON cache(tool_name);
      CREATE INDEX IF NOT EXISTS idx_cache_expires   ON cache(expires_at);
    `);
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get();
    if (!row) {
      this.db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)`).run(String(SCHEMA_VERSION));
    }
  }
  /**
   * Look up an entry by hash. Returns undefined for misses, expired entries
   * (expired entries are also evicted on read), or any non-found state.
   */
  get(hash, now = nowSeconds()) {
    const row = this.stmts.get.get(hash);
    if (!row) return void 0;
    if (row.expiresAt > 0 && row.expiresAt <= now) {
      this.stmts.deleteByHash.run(hash);
      return void 0;
    }
    this.stmts.touch.run(now, hash);
    return { ...row, lastUsedAt: now, hits: row.hits + 1 };
  }
  put(hash, toolName, value, opts = {}, now = nowSeconds()) {
    const expiresAt = opts.ttlSeconds && opts.ttlSeconds > 0 ? now + opts.ttlSeconds : 0;
    const entry = {
      hash,
      toolName,
      toolInputJson: opts.toolInputJson ?? "{}",
      value,
      sizeBytes: Buffer.byteLength(value, "utf8"),
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      hits: 0
    };
    this.stmts.upsert.run(entry);
    this.evictIfNeeded();
    return entry;
  }
  invalidateHash(hash) {
    this.stmts.deleteByHash.run(hash);
  }
  invalidateByTool(toolName) {
    const result = this.stmts.deleteByTool.run(toolName);
    return Number(result.changes);
  }
  invalidateAll() {
    const result = this.stmts.deleteAll.run();
    return Number(result.changes);
  }
  /**
   * Drop every Read entry whose stored tool input mentions the given absolute
   * path. Triggered by PostToolUse on Edit/Write/MultiEdit. The match uses
   * SQLite LIKE on the JSON-serialized input — coarse but correct: false
   * positives mean we drop a few extra reads, never the wrong invalidation.
   */
  invalidateReadsForPath(absolutePath) {
    const escaped = absolutePath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const pattern = `%${JSON.stringify(escaped).slice(1, -1)}%`;
    const result = this.stmts.deleteForReadPath.run(pattern);
    return Number(result.changes);
  }
  stats() {
    const totalRows = this.stmts.countAll.get().c;
    const totalBytes = this.stmts.sumSize.get().b;
    const perTool = this.stmts.statsByTool.all();
    return { totalRows, totalBytes, perTool };
  }
  close() {
    this.db.close();
  }
  evictIfNeeded() {
    const total = this.stmts.countAll.get().c;
    if (total <= this.maxRows) return;
    const overshoot = total - this.maxRows;
    this.stmts.deleteOldest.run(overshoot);
  }
};
function nowSeconds() {
  return Math.floor(Date.now() / 1e3);
}

// src/cli.ts
var dbPath = (0, import_node_path2.join)(
  process.env.CLAUDE_DEJAVU_HOME ?? (0, import_node_path2.join)((0, import_node_os.homedir)(), ".claude-dejavu"),
  "cache.db"
);
var args = process.argv.slice(2);
var cmd = args[0] ?? "--help";
switch (cmd) {
  case "stats":
    runStats();
    break;
  case "clear":
    runClear(args.slice(1));
    break;
  case "why":
    runWhy(args[1]);
    break;
  case "--help":
  case "-h":
  case "help":
    printUsage();
    break;
  default:
    console.error(`unknown subcommand: ${cmd}`);
    printUsage();
    process.exit(1);
}
function runStats() {
  const store = new CacheStore(dbPath);
  try {
    const s = store.stats();
    const lines = [];
    lines.push("claude-dejavu \u2014 cache statistics");
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
          "    " + t.toolName.padEnd(12) + String(t.rows).padStart(4) + "    " + String(t.hits).padStart(4) + "    " + formatBytes(t.bytes)
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
function runClear(rest) {
  const store = new CacheStore(dbPath);
  try {
    const toolIdx = rest.indexOf("--tool");
    if (toolIdx >= 0) {
      const toolName = rest[toolIdx + 1];
      if (!toolName) {
        console.error("--tool requires an argument (e.g. --tool Read)");
        process.exit(1);
      }
      const dropped2 = store.invalidateByTool(toolName);
      console.log(`claude-dejavu: removed ${dropped2} entr${dropped2 === 1 ? "y" : "ies"} for ${toolName}`);
      return;
    }
    const dropped = store.invalidateAll();
    console.log(`claude-dejavu: removed ${dropped} entr${dropped === 1 ? "y" : "ies"} (full wipe)`);
  } finally {
    store.close();
  }
}
function runWhy(hashPrefix) {
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
    const all = store.stats().perTool;
    console.log(
      `claude-dejavu: prefix lookup not implemented for short hashes yet; pass the full 64-char hash from the cache hit message.`
    );
  } finally {
    store.close();
  }
}
function formatEntry(entry) {
  const ttl = entry.expiresAt === 0 ? "(no TTL \u2014 mtime-based)" : `${entry.expiresAt - Math.floor(Date.now() / 1e3)}s remaining`;
  return [
    `hash       : ${entry.hash}`,
    `tool       : ${entry.toolName}`,
    `tool_input : ${entry.toolInputJson}`,
    `size       : ${formatBytes(entry.sizeBytes)}`,
    `created    : ${new Date(entry.createdAt * 1e3).toISOString()}`,
    `last_used  : ${new Date(entry.lastUsedAt * 1e3).toISOString()}`,
    `ttl        : ${ttl}`,
    `hits       : ${entry.hits}`
  ].join("\n");
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function printUsage() {
  console.log(
    [
      "claude-dejavu \u2014 cache control",
      "",
      "Usage:",
      "  /dejavu stats                       Show cache hit / size / per-tool stats",
      "  /dejavu clear                       Drop every cached entry",
      "  /dejavu clear --tool <ToolName>     Drop entries for one tool",
      "  /dejavu why <hash>                  Inspect a single cache entry",
      "",
      "Data directory:",
      "  $CLAUDE_DEJAVU_HOME, defaults to ~/.claude-dejavu/"
    ].join("\n")
  );
}
