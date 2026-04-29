# FAQ

### Will it cache stale results?

No. Read entries are mtime-tracked: as soon as the file changes, the cache key
changes too, and the next call misses. Grep/Glob and Bash entries carry a TTL
(5 min and 1 h by default — both configurable). Edit/Write/MultiEdit on a file
explicitly evicts every Read entry that mentions that path.

### Does it work with MCP tools?

Not by default. MCP servers know their own data freshness model — caching
their tool results from outside would risk subtle bugs. v0.2 will add an
opt-in mode for MCP servers that explicitly declare cache-friendly tools.

### How much disk does the cache use?

Default cap: 50 000 rows, 256 KB per row, ~12 MB worst-case database. Tweak
with `maxRows` and `maxValueBytes` in `~/.claude-dejavu/config.json`.

### Can I disable caching for a specific Bash command?

Yes — add it to `bash.deny` in `~/.claude-dejavu/config.json`. Or disable a
whole tool with `disabledTools: ["Read"]`.

### Can I extend the safe-Bash whitelist?

Yes — add commands to `bash.allow`. They have to be **read-only** by your own
judgement; the classifier still applies its structural rules (no `>`, no
`$(...)`, etc.) on top.

### Does the plugin run anything when I'm not using it?

It only runs when Claude Code fires a `PreToolUse` or `PostToolUse` hook on a
matched tool. Each invocation is a single short-lived `node` process — under
50 ms for a hit, capped at 5 s by Claude Code itself.

### What happens on a cache crash?

Hooks fail open. Any exception is logged to `~/.claude-dejavu/logs/dejavu.log`
and the hook returns an `allow` response — Claude Code runs the underlying
tool exactly as if the plugin weren't there.

### Does the cached payload get re-injected into the conversation?

Yes. On a cache hit `PreToolUse` returns a `deny` decision with an
`additionalContext` field carrying the cached output, prefixed with the
`[claude-dejavu CACHE_HIT]` marker. Claude reads it the same way it would read
the actual tool result.

### Where are the logs?

`~/.claude-dejavu/logs/dejavu.log`, JSON-line format (pino default).
