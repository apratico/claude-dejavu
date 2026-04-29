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

// src/hooks/pre-tool-use.ts
var import_node_os3 = require("node:os");
var import_node_path6 = require("node:path");

// src/cache/store.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var SCHEMA_VERSION = 1;
var CacheStore = class {
  db;
  maxRows;
  stmts;
  constructor(dbPath, opts = {}) {
    (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(dbPath), { recursive: true });
    this.db = new import_better_sqlite3.default(dbPath);
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

// src/cache/key.ts
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");
function buildKey(ctx) {
  const cwd = (0, import_node_path2.resolve)(ctx.cwd);
  const normalizedInput = canonicalizeJson(ctx.toolInput);
  const mtimes = ctx.mtimeFiles.map((p) => (0, import_node_path2.isAbsolute)(p) ? p : (0, import_node_path2.resolve)(cwd, p)).sort().map((path) => ({ path, mtimeNs: readMtimeNs(path) }));
  const canonical = {
    toolName: ctx.toolName,
    toolInput: normalizedInput,
    cwd,
    mtimes
  };
  const hash = (0, import_node_crypto.createHash)("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { hash, canonical };
}
function readMtimeNs(path) {
  if (!(0, import_node_fs2.existsSync)(path)) return null;
  try {
    return (0, import_node_fs2.statSync)(path, { bigint: true }).mtimeNs.toString();
  } catch {
    return null;
  }
}
function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  const obj = value;
  const sorted = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalizeJson(obj[k]);
  }
  return sorted;
}

// src/config/load.ts
var import_node_fs3 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");
var DEFAULT_CONFIG = {
  enabled: true,
  ttl: {
    bash: 60 * 60,
    // 1h
    read: 0,
    // mtime-based, unbounded otherwise
    grep: 5 * 60
    // 5m
  },
  bash: {
    allow: [],
    deny: []
  },
  disabledTools: [],
  maxRows: 5e4,
  maxValueBytes: 256 * 1024
  // 256 KB per entry
};
function configPath() {
  if (process.env.CLAUDE_DEJAVU_CONFIG) return process.env.CLAUDE_DEJAVU_CONFIG;
  const home = process.env.CLAUDE_DEJAVU_HOME ?? (0, import_node_path3.join)((0, import_node_os.homedir)(), ".claude-dejavu");
  return (0, import_node_path3.join)(home, "config.json");
}
function loadConfig(path = configPath()) {
  if (!(0, import_node_fs3.existsSync)(path)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse((0, import_node_fs3.readFileSync)(path, "utf8"));
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return DEFAULT_CONFIG;
  }
}
function mergeConfig(base, override) {
  return {
    enabled: override.enabled ?? base.enabled,
    ttl: { ...base.ttl, ...override.ttl ?? {} },
    bash: {
      allow: dedupe([...base.bash.allow, ...override.bash?.allow ?? []]),
      deny: dedupe([...base.bash.deny, ...override.bash?.deny ?? []])
    },
    disabledTools: dedupe([...base.disabledTools, ...override.disabledTools ?? []]),
    maxRows: override.maxRows ?? base.maxRows,
    maxValueBytes: override.maxValueBytes ?? base.maxValueBytes
  };
}
function dedupe(values) {
  return [...new Set(values)];
}

// src/policy/tool-whitelist.ts
var import_node_path4 = require("node:path");

// src/policy/bash-classifier.ts
var READ_ONLY_BASE_COMMANDS = /* @__PURE__ */ new Set([
  "ls",
  "ll",
  "cat",
  "head",
  "tail",
  "wc",
  "less",
  "more",
  "find",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ack",
  "awk",
  "sed",
  // mutations gated below
  "tr",
  "sort",
  "uniq",
  "cut",
  "paste",
  "tree",
  "stat",
  "file",
  "pwd",
  "whoami",
  "hostname",
  "uname",
  "id",
  "groups",
  "date",
  "which",
  "type",
  "command",
  "echo",
  "printf",
  "true",
  "false",
  "env",
  "diff",
  "cmp",
  "basename",
  "dirname",
  "git",
  // sub-command gated below
  "hg",
  // status/log only
  "node",
  "npm",
  // version/list only
  "mvn",
  "gradle",
  "java",
  "javac",
  "python",
  "python3",
  "go",
  "rustc",
  "cargo",
  "tsc",
  "kubectl",
  // only `get|describe|logs` etc. — gated below
  "docker",
  // only inspect-class — gated below
  "df",
  "du",
  "free",
  "uptime",
  "ps",
  "top",
  "history",
  "tac",
  "jq",
  "yq",
  "base64",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum"
]);
var SUBCOMMAND_ALLOWLIST = /* @__PURE__ */ new Map([
  ["git", /* @__PURE__ */ new Set([
    "log",
    "status",
    "diff",
    "show",
    "branch",
    "tag",
    "remote",
    "rev-parse",
    "config",
    "describe",
    "blame",
    "ls-files",
    "ls-tree",
    "cat-file",
    "shortlog",
    "reflog"
  ])],
  ["hg", /* @__PURE__ */ new Set(["log", "status", "diff", "branches", "tags"])],
  ["npm", /* @__PURE__ */ new Set(["ls", "list", "view", "outdated", "config", "doctor", "ping", "pkg"])],
  ["node", /* @__PURE__ */ new Set(["--version", "-v"])],
  ["mvn", /* @__PURE__ */ new Set(["-version", "--version", "-v"])],
  ["gradle", /* @__PURE__ */ new Set(["-version", "--version", "-v"])],
  ["java", /* @__PURE__ */ new Set(["-version", "--version"])],
  ["javac", /* @__PURE__ */ new Set(["-version", "--version"])],
  ["python", /* @__PURE__ */ new Set(["--version", "-V"])],
  ["python3", /* @__PURE__ */ new Set(["--version", "-V"])],
  ["go", /* @__PURE__ */ new Set(["version", "env"])],
  ["rustc", /* @__PURE__ */ new Set(["--version", "-V"])],
  ["cargo", /* @__PURE__ */ new Set(["--version", "-V"])],
  ["tsc", /* @__PURE__ */ new Set(["--version", "-v"])],
  ["kubectl", /* @__PURE__ */ new Set([
    "get",
    "describe",
    "logs",
    "version",
    "config",
    "api-resources",
    "api-versions",
    "explain",
    "top",
    "auth"
  ])],
  ["docker", /* @__PURE__ */ new Set([
    "ps",
    "images",
    "inspect",
    "logs",
    "version",
    "info",
    "stats",
    "history",
    "search",
    "diff",
    "context"
  ])]
]);
var FORBIDDEN_FLAGS_PER_BASE = /* @__PURE__ */ new Map([
  ["sed", [/^-i$/, /^--in-place(=|$)/]],
  ["find", [/^-delete$/, /^-exec$/, /^-execdir$/, /^-ok$/, /^-okdir$/]],
  ["awk", [/^-i$/, /^--in-place(=|$)/]]
]);
var STRUCTURAL_BLOCKLIST = [
  { pattern: /(^|[^>])>(?!&)/, reason: "redirect-to-file (`>`)" },
  { pattern: />>/, reason: "append-to-file (`>>`)" },
  { pattern: /<\(/, reason: "process-substitution (`<(...)`)" },
  { pattern: /\$\(/, reason: "command-substitution (`$(...)`)" },
  { pattern: /`/, reason: "backtick command-substitution" },
  { pattern: /;/, reason: "command separator (`;`)" },
  { pattern: /&&/, reason: "logical-and (`&&`)" },
  { pattern: /\|\|/, reason: "logical-or (`||`)" },
  { pattern: /(^|\s)&\s*$/, reason: "background (`&`)" },
  { pattern: /\bsudo\b/, reason: "privilege escalation (`sudo`)" }
];
function classifyBashCommand(command, overrides = {}) {
  const trimmed = command.trim();
  if (!trimmed) return { cacheable: false, reason: "empty command" };
  for (const { pattern, reason } of STRUCTURAL_BLOCKLIST) {
    if (pattern.test(trimmed)) return { cacheable: false, reason };
  }
  const segments = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { cacheable: false, reason: "empty pipeline" };
  const denySet = new Set(overrides.deny ?? []);
  const allowSet = /* @__PURE__ */ new Set([...READ_ONLY_BASE_COMMANDS, ...overrides.allow ?? []]);
  for (const segment of segments) {
    const verdict = classifySegment(segment, allowSet, denySet);
    if (!verdict.cacheable) return verdict;
  }
  return { cacheable: true, reason: "ok" };
}
function classifySegment(segment, allowSet, denySet) {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return { cacheable: false, reason: "empty segment" };
  const [base, ...rest] = tokens;
  if (denySet.has(base)) {
    return { cacheable: false, reason: `'${base}' is in deny list` };
  }
  if (!allowSet.has(base)) {
    return { cacheable: false, reason: `'${base}' is not in the read-only whitelist` };
  }
  const subAllowlist = SUBCOMMAND_ALLOWLIST.get(base);
  if (subAllowlist) {
    const sub = rest[0];
    if (!sub || !subAllowlist.has(sub)) {
      return {
        cacheable: false,
        reason: `'${base}' requires a read-only sub-command (got '${sub ?? "<none>"}')`
      };
    }
  }
  const forbidden = FORBIDDEN_FLAGS_PER_BASE.get(base);
  if (forbidden) {
    for (const tok of rest) {
      for (const re of forbidden) {
        if (re.test(tok)) {
          return { cacheable: false, reason: `'${base} ${tok}' is a mutating form` };
        }
      }
    }
  }
  return { cacheable: true, reason: "ok" };
}
function tokenize(input) {
  const out = [];
  let cur = "";
  let i = 0;
  let mode = "normal";
  while (i < input.length) {
    const ch = input[i];
    if (mode === "normal") {
      if (ch === "'") {
        mode = "single";
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "double";
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        cur += input[i + 1];
        i += 2;
        continue;
      }
      if (/\s/.test(ch)) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (mode === "single") {
      if (ch === "'") {
        mode = "normal";
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (mode === "double") {
      if (ch === '"') {
        mode = "normal";
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        cur += input[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// src/policy/tool-whitelist.ts
function classifyToolCall(toolName, toolInput, cwd, cfg) {
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
      const abs = (0, import_node_path4.isAbsolute)(filePath) ? filePath : (0, import_node_path4.resolve)(cwd, filePath);
      return {
        cacheable: true,
        reason: "ok",
        mtimeFiles: [abs],
        ttlBucket: "read",
        keyInput: pickFields(toolInput, ["file_path", "offset", "limit"])
      };
    }
    case "Grep": {
      return {
        cacheable: true,
        reason: "ok (TTL-only)",
        mtimeFiles: [],
        ttlBucket: "grep",
        keyInput: pickFields(toolInput, [
          "pattern",
          "path",
          "glob",
          "type",
          "output_mode",
          "head_limit",
          "multiline",
          "-i",
          "-n",
          "-A",
          "-B",
          "-C"
        ])
      };
    }
    case "Glob": {
      return {
        cacheable: true,
        reason: "ok (TTL-only)",
        mtimeFiles: [],
        ttlBucket: "grep",
        keyInput: pickFields(toolInput, ["pattern", "path"])
      };
    }
    case "Bash": {
      const command = typeof toolInput.command === "string" ? toolInput.command : "";
      const verdict = classifyBashCommand(command, {
        allow: cfg.bash.allow,
        deny: cfg.bash.deny
      });
      return {
        cacheable: verdict.cacheable,
        reason: verdict.reason,
        mtimeFiles: [],
        ttlBucket: verdict.cacheable ? "bash" : "none",
        // Only the actual command is semantic — `description`, `timeout`,
        // `run_in_background` and other UI metadata must NOT enter the key.
        keyInput: { command }
      };
    }
    default:
      return {
        cacheable: false,
        reason: `tool '${toolName}' not in supported set`,
        mtimeFiles: [],
        ttlBucket: "none",
        keyInput: {}
      };
  }
}
function pickFields(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, f)) {
      out[f] = obj[f];
    }
  }
  return out;
}
function ttlForBucket(bucket, cfg) {
  switch (bucket) {
    case "read":
      return cfg.ttl.read;
    case "grep":
      return cfg.ttl.grep;
    case "bash":
      return cfg.ttl.bash;
    case "none":
      return 0;
  }
}

// src/hooks/io.ts
async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty stdin");
  return JSON.parse(raw);
}
function writeJsonStdout(payload) {
  process.stdout.write(JSON.stringify(payload));
}
function allowPre() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow"
    }
  };
}
function denyPreWithCachedContext(reason, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext
    }
  };
}

// src/log.ts
var import_node_fs4 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path5 = require("node:path");
var import_pino = __toESM(require("pino"));
var dataDir = process.env.CLAUDE_DEJAVU_HOME ?? (0, import_node_path5.join)((0, import_node_os2.homedir)(), ".claude-dejavu");
var logDir = (0, import_node_path5.join)(dataDir, "logs");
(0, import_node_fs4.mkdirSync)(logDir, { recursive: true });
var logFile = (0, import_node_path5.join)(logDir, "dejavu.log");
var stream = (0, import_node_fs4.createWriteStream)(logFile, { flags: "a" });
var log = (0, import_pino.default)(
  {
    level: process.env.CLAUDE_DEJAVU_LOG_LEVEL ?? "info",
    base: void 0,
    timestamp: import_pino.default.stdTimeFunctions.isoTime
  },
  stream
);
async function withErrorLogging(name, fn) {
  try {
    await fn();
  } catch (err) {
    log.error({ hook: name, err: serializeError(err) }, "hook crashed");
  }
}
function serializeError(err) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

// src/hooks/pre-tool-use.ts
var CACHE_MARKER = "[claude-dejavu CACHE_HIT]";
void withErrorLogging("pre-tool-use", async () => {
  let input;
  try {
    input = await readJsonStdin();
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
  const dbPath = (0, import_node_path6.join)(
    process.env.CLAUDE_DEJAVU_HOME ?? (0, import_node_path6.join)((0, import_node_os3.homedir)(), ".claude-dejavu"),
    "cache.db"
  );
  const store = new CacheStore(dbPath, { maxRows: cfg.maxRows });
  try {
    const { hash } = buildKey({
      toolName: input.tool_name,
      toolInput: verdict.keyInput,
      cwd: input.cwd,
      mtimeFiles: verdict.mtimeFiles
    });
    const entry = store.get(hash);
    if (entry) {
      const ttl = ttlForBucket(verdict.ttlBucket, cfg);
      log.info(
        { tool: input.tool_name, hash, hits: entry.hits, sizeBytes: entry.sizeBytes, ttl },
        "pre: cache HIT"
      );
      writeJsonStdout(
        denyPreWithCachedContext(
          `claude-dejavu cache hit (key=${hash.slice(0, 12)})`,
          formatCachedContext(input.tool_name, hash, entry.value)
        )
      );
      return;
    }
    log.info({ tool: input.tool_name, hash }, "pre: cache MISS, allowing");
    writeJsonStdout(allowPre());
  } finally {
    store.close();
  }
});
function formatCachedContext(toolName, hash, value) {
  return [
    `${CACHE_MARKER} tool=${toolName} key=${hash.slice(0, 12)}`,
    "The tool was not re-executed \u2014 claude-dejavu replayed the result of a prior identical call.",
    "If the underlying state has changed unexpectedly, re-run with `/dejavu clear` and try again.",
    "",
    "--- result begin ---",
    value,
    "--- result end ---"
  ].join("\n");
}
