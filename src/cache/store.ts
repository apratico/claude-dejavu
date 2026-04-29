import Database, { type Database as Db, type Statement } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Stmt = Statement<unknown[], unknown>;

/**
 * SQLite-backed cache store. Single-process-safe through the SQLite WAL
 * journal mode; multiple Claude Code processes hitting the same DB file
 * will serialize through the WAL, which is the supported usage pattern.
 */
export interface CacheEntry {
  hash: string;
  toolName: string;
  /** JSON-serialized tool_input — useful for `/dejavu why` debugging. */
  toolInputJson: string;
  /** Cached payload — opaque string, hooks pick the encoding. */
  value: string;
  /** Bytes of `value` for accounting / LRU eviction. */
  sizeBytes: number;
  /** Unix epoch seconds the entry was first written. */
  createdAt: number;
  /** Unix epoch seconds the entry was last served. Updated on every hit. */
  lastUsedAt: number;
  /** Unix epoch seconds at which the entry expires; 0 = no TTL. */
  expiresAt: number;
  /** Number of times this entry was served. */
  hits: number;
}

export interface PutOptions {
  ttlSeconds?: number;
  toolInputJson?: string;
}

const SCHEMA_VERSION = 1;

export class CacheStore {
  private readonly db: Db;
  private readonly maxRows: number;
  private readonly stmts: {
    get: Stmt;
    upsert: Stmt;
    touch: Stmt;
    deleteByHash: Stmt;
    deleteByTool: Stmt;
    deleteAll: Stmt;
    countAll: Stmt;
    sumSize: Stmt;
    statsByTool: Stmt;
    deleteOldest: Stmt;
    deleteForReadPath: Stmt;
  };

  constructor(dbPath: string, opts: { maxRows?: number } = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.maxRows = opts.maxRows ?? 50_000;

    this.migrate();

    this.stmts = {
      get: this.db.prepare(
        `SELECT hash, tool_name AS toolName, tool_input_json AS toolInputJson,
                value, size_bytes AS sizeBytes,
                created_at AS createdAt, last_used_at AS lastUsedAt,
                expires_at AS expiresAt, hits
           FROM cache WHERE hash = ?`,
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
           last_used_at = excluded.last_used_at`,
      ),
      touch: this.db.prepare(
        `UPDATE cache SET last_used_at = ?, hits = hits + 1 WHERE hash = ?`,
      ),
      deleteByHash: this.db.prepare(`DELETE FROM cache WHERE hash = ?`),
      deleteByTool: this.db.prepare(`DELETE FROM cache WHERE tool_name = ?`),
      deleteAll:    this.db.prepare(`DELETE FROM cache`),
      countAll:     this.db.prepare(`SELECT COUNT(*) AS c FROM cache`),
      sumSize:      this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS b FROM cache`),
      statsByTool:  this.db.prepare(
        `SELECT tool_name AS toolName, COUNT(*) AS rows, SUM(hits) AS hits, SUM(size_bytes) AS bytes
           FROM cache GROUP BY tool_name ORDER BY rows DESC`,
      ),
      deleteOldest: this.db.prepare(
        `DELETE FROM cache WHERE hash IN (
           SELECT hash FROM cache ORDER BY last_used_at ASC LIMIT ?
         )`,
      ),
      deleteForReadPath: this.db.prepare(
        `DELETE FROM cache WHERE tool_name = 'Read' AND tool_input_json LIKE ?`,
      ),
    };
  }

  private migrate(): void {
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
    const row = this.db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
      .get() as { value: string } | undefined;
    if (!row) {
      this.db
        .prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', ?)`)
        .run(String(SCHEMA_VERSION));
    }
  }

  /**
   * Look up an entry by hash. Returns undefined for misses, expired entries
   * (expired entries are also evicted on read), or any non-found state.
   */
  get(hash: string, now: number = nowSeconds()): CacheEntry | undefined {
    const row = this.stmts.get.get(hash) as CacheEntry | undefined;
    if (!row) return undefined;
    if (row.expiresAt > 0 && row.expiresAt <= now) {
      this.stmts.deleteByHash.run(hash);
      return undefined;
    }
    this.stmts.touch.run(now, hash);
    return { ...row, lastUsedAt: now, hits: row.hits + 1 };
  }

  put(
    hash: string,
    toolName: string,
    value: string,
    opts: PutOptions = {},
    now: number = nowSeconds(),
  ): CacheEntry {
    const expiresAt = opts.ttlSeconds && opts.ttlSeconds > 0 ? now + opts.ttlSeconds : 0;
    const entry: CacheEntry = {
      hash,
      toolName,
      toolInputJson: opts.toolInputJson ?? "{}",
      value,
      sizeBytes: Buffer.byteLength(value, "utf8"),
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      hits: 0,
    };
    this.stmts.upsert.run(entry);
    this.evictIfNeeded();
    return entry;
  }

  invalidateHash(hash: string): void {
    this.stmts.deleteByHash.run(hash);
  }

  invalidateByTool(toolName: string): number {
    const result = this.stmts.deleteByTool.run(toolName);
    return Number(result.changes);
  }

  invalidateAll(): number {
    const result = this.stmts.deleteAll.run();
    return Number(result.changes);
  }

  /**
   * Drop every Read entry whose stored tool input mentions the given absolute
   * path. Triggered by PostToolUse on Edit/Write/MultiEdit. The match uses
   * SQLite LIKE on the JSON-serialized input — coarse but correct: false
   * positives mean we drop a few extra reads, never the wrong invalidation.
   */
  invalidateReadsForPath(absolutePath: string): number {
    const escaped = absolutePath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const pattern = `%${JSON.stringify(escaped).slice(1, -1)}%`;
    const result = this.stmts.deleteForReadPath.run(pattern);
    return Number(result.changes);
  }

  stats(): {
    totalRows: number;
    totalBytes: number;
    perTool: Array<{ toolName: string; rows: number; hits: number; bytes: number }>;
  } {
    const totalRows  = (this.stmts.countAll.get() as { c: number }).c;
    const totalBytes = (this.stmts.sumSize.get()  as { b: number }).b;
    const perTool    = this.stmts.statsByTool.all() as Array<{
      toolName: string; rows: number; hits: number; bytes: number;
    }>;
    return { totalRows, totalBytes, perTool };
  }

  close(): void {
    this.db.close();
  }

  private evictIfNeeded(): void {
    const total = (this.stmts.countAll.get() as { c: number }).c;
    if (total <= this.maxRows) return;
    const overshoot = total - this.maxRows;
    this.stmts.deleteOldest.run(overshoot);
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
