# Architecture

## Hook integration

claude-dejavu plugs into Claude Code through three hook events declared in
`hooks/hooks.json`:

| Event           | Matcher                  | Purpose                                                                            |
|-----------------|--------------------------|------------------------------------------------------------------------------------|
| `Setup`         | `*`                      | Run once on install: `npm install` (native deps) and create `~/.claude-dejavu/`.   |
| `PreToolUse`    | `Read|Grep|Glob|Bash`    | Lookup; on hit deny + inject cached payload via `additionalContext`.               |
| `PostToolUse`   | `Read|Grep|Glob|Bash`    | Persist the tool's actual output under the same key. Also invalidate Read entries on Edit/Write/MultiEdit (planned in v0.2; v0.1 invalidates eagerly via PostToolUse pattern matching). |

Hook scripts read JSON on stdin and write JSON on stdout, following the
[official hook protocol](https://code.claude.com/docs/en/hooks). Both hooks
**fail open** — any exception is logged and the response defaults to `allow`,
so a misbehaving cache never blocks a real tool call.

## Cache-hit semantics

The Claude Code 2026 hook contract does not let `PreToolUse` *replace* a tool's
output — `permissionDecision` is limited to `allow | deny | ask | defer`. To
return cached data we therefore:

1. emit `permissionDecision: "deny"` so the underlying tool never runs, and
2. set `additionalContext` to the cached payload, prefixed with a clear
   `[claude-dejavu CACHE_HIT]` marker.

Claude consumes the additional context as if it were any other system
observation. We keep the marker explicit so the user can see in the transcript
exactly when the cache fired, and `/dejavu why <hash>` can correlate to the
source entry.

The savings come from three sources:

- **Latency.** No tool execution → no FS scan, no `git` subprocess, no IPC.
- **I/O.** Heavy `Grep` queries don't re-walk the workspace each time.
- **Output-token churn.** When the cache payload is shorter than the would-be
  raw tool output (large `git log`, multi-file `Read`, deep `Glob`), the
  context window stays smaller for subsequent reasoning steps. v0.2 will add
  pointer-style `additionalContext` (`"identical to turn N — see prior message"`)
  to widen the input-token win on long sessions.

## Cache key

Implemented in `src/cache/key.ts`. SHA-256 of a canonicalized JSON object:

```
{
  toolName,
  toolInput,                  // recursively key-sorted JSON
  cwd,                        // resolved to absolute path
  mtimes: [{ path, mtimeNs }] // sorted by path; null for absent files
}
```

Per tool:

| Tool   | mtime files                          | TTL bucket     | Invalidation      |
|--------|--------------------------------------|----------------|-------------------|
| `Read` | `[file_path]`                        | `read` (∞)     | mtime-based       |
| `Grep` | `[]`                                 | `grep` (5 min) | TTL               |
| `Glob` | `[]`                                 | `grep` (5 min) | TTL               |
| `Bash` | `[]`                                 | `bash` (1 h)   | TTL               |

`Grep` / `Glob` entries are not mtime-tracked because computing the affected
file set at lookup time is roughly as expensive as just running the tool. A
short TTL is the pragmatic tradeoff. v0.2 plans an opt-in mode that reuses the
prior tool result's matched-file list to guard the entry.

## Bash classifier

`src/policy/bash-classifier.ts`. Conservative whitelist + safe-pipe extension
("option C" in the design notes):

1. Reject any structural side-effect: `>`, `>>`, `;`, `&&`, `||`, `<(...)`,
   `$(...)`, backticks, trailing `&`, `sudo`.
2. Split the command on `|`. Every segment must be cacheable on its own.
3. The first token of each segment must be in the read-only whitelist
   (`ls`, `cat`, `grep`, `git`, `npm`, …) and must not match a per-command
   forbidden flag (`sed -i`, `find -delete`, `awk -i`, …).
4. For multi-mode tools (`git`, `kubectl`, `docker`, `npm`), the sub-command
   must be in an explicit allowlist (`git log|status|diff|...`,
   `kubectl get|describe|logs|...`).

The classifier never executes or evals the command. `tokenize()` is a small
quote-aware lexer with backslash-escape support — sufficient for argv splitting
in the classifier, never used to dispatch a real shell.

False positives (running a side-effecting command from cache) are catastrophic;
false negatives (missing a cacheable command) just leave tokens on the table.
Bias is firmly toward false negatives.

## Storage

SQLite via `better-sqlite3`, WAL mode for concurrent readers, in
`~/.claude-dejavu/cache.db`. Schema (v1):

```sql
CREATE TABLE cache (
  hash             TEXT PRIMARY KEY,
  tool_name        TEXT NOT NULL,
  tool_input_json  TEXT NOT NULL,
  value            TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,  -- 0 = unbounded
  hits             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_cache_lru     ON cache(last_used_at);
CREATE INDEX idx_cache_tool    ON cache(tool_name);
CREATE INDEX idx_cache_expires ON cache(expires_at);
```

LRU eviction triggers when the table exceeds `config.maxRows` (default 50k).
Per-entry size is capped at `config.maxValueBytes` (default 256 KB) — anything
larger is observed but not stored.

## Privacy

The DB lives strictly under `$CLAUDE_DEJAVU_HOME` (default `~/.claude-dejavu/`)
on the user's machine. Slash command output never echoes the cached value
verbatim — `stats` reports counts and bytes only; `why` shows tool name, args
and metadata but not the payload (use the cached additionalContext block in
the transcript to inspect the actual content).
