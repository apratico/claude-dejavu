/**
 * Bash classifier. Conservative whitelist + safe-pipe extension (option C).
 *
 * Goal: decide whether a Bash invocation is **read-only and side-effect free**
 * with high confidence. False positives (running a side-effecting command from
 * the cache) are catastrophic; false negatives (missing a cacheable read-only
 * command) are merely a missed token-saving opportunity. Bias the classifier
 * toward false negatives.
 *
 * The classifier never executes or evals the command. It performs a structural
 * check on the literal command string.
 */

const READ_ONLY_BASE_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "ll",
  "cat", "head", "tail", "wc", "less", "more",
  "find",
  "grep", "egrep", "fgrep", "rg", "ack",
  "awk", "sed",          // mutations gated below
  "tr",
  "sort", "uniq", "cut", "paste",
  "tree",
  "stat", "file",
  "pwd", "whoami", "hostname", "uname", "id", "groups",
  "date",
  "which", "type", "command",
  "echo", "printf", "true", "false",
  "env",
  "diff", "cmp",
  "basename", "dirname",
  "git",                  // sub-command gated below
  "hg",                   // status/log only
  "node", "npm",          // version/list only
  "mvn", "gradle",
  "java", "javac",
  "python", "python3",
  "go", "rustc", "cargo",
  "tsc",
  "kubectl",              // only `get|describe|logs` etc. — gated below
  "docker",               // only inspect-class — gated below
  "df", "du", "free", "uptime", "ps", "top",
  "history",
  "tac",
  "jq", "yq",
  "base64",
  "md5sum", "sha1sum", "sha256sum", "shasum",
]);

/** Sub-commands that mark an otherwise-multimode tool as read-only. */
const SUBCOMMAND_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["git",     new Set(["log", "status", "diff", "show", "branch", "tag", "remote", "rev-parse",
                       "config", "describe", "blame", "ls-files", "ls-tree", "cat-file",
                       "shortlog", "reflog"])],
  ["hg",      new Set(["log", "status", "diff", "branches", "tags"])],
  ["npm",     new Set(["ls", "list", "view", "outdated", "config", "doctor", "ping", "pkg"])],
  ["node",    new Set(["--version", "-v"])],
  ["mvn",     new Set(["-version", "--version", "-v"])],
  ["gradle",  new Set(["-version", "--version", "-v"])],
  ["java",    new Set(["-version", "--version"])],
  ["javac",   new Set(["-version", "--version"])],
  ["python",  new Set(["--version", "-V"])],
  ["python3", new Set(["--version", "-V"])],
  ["go",      new Set(["version", "env"])],
  ["rustc",   new Set(["--version", "-V"])],
  ["cargo",   new Set(["--version", "-V"])],
  ["tsc",     new Set(["--version", "-v"])],
  ["kubectl", new Set(["get", "describe", "logs", "version", "config", "api-resources",
                       "api-versions", "explain", "top", "auth"])],
  ["docker",  new Set(["ps", "images", "inspect", "logs", "version", "info", "stats", "history",
                       "search", "diff", "context"])],
]);

/** Flags that turn an otherwise-read-only command into a mutation. */
const FORBIDDEN_FLAGS_PER_BASE: ReadonlyMap<string, ReadonlyArray<RegExp>> = new Map([
  ["sed",     [/^-i$/, /^--in-place(=|$)/]],
  ["find",    [/^-delete$/, /^-exec$/, /^-execdir$/, /^-ok$/, /^-okdir$/]],
  ["awk",     [/^-i$/, /^--in-place(=|$)/]],
]);

/**
 * Forbid any of these characters/sequences anywhere in the command — they
 * either let arbitrary code execute or write to the filesystem, both of
 * which break the "read-only" invariant.
 */
const STRUCTURAL_BLOCKLIST: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[^>])>(?!&)/,        reason: "redirect-to-file (`>`)" },
  { pattern: />>/,                    reason: "append-to-file (`>>`)" },
  { pattern: /<\(/,                   reason: "process-substitution (`<(...)`)" },
  { pattern: /\$\(/,                  reason: "command-substitution (`$(...)`)" },
  { pattern: /`/,                     reason: "backtick command-substitution" },
  { pattern: /;/,                     reason: "command separator (`;`)" },
  { pattern: /&&/,                    reason: "logical-and (`&&`)" },
  { pattern: /\|\|/,                  reason: "logical-or (`||`)" },
  { pattern: /(^|\s)&\s*$/,           reason: "background (`&`)" },
  { pattern: /\bsudo\b/,              reason: "privilege escalation (`sudo`)" },
];

export interface ClassifierOverrides {
  /** Extra base commands to allow. Added to the read-only set. */
  allow?: ReadonlyArray<string>;
  /** Base commands to never cache, even if otherwise allowlisted. */
  deny?: ReadonlyArray<string>;
}

export interface Classification {
  cacheable: boolean;
  reason: string;
}

/**
 * Decide whether a Bash command is cacheable. Returns the verdict with a
 * human-readable reason — the reason is surfaced to the user via
 * `/dejavu why`.
 */
export function classifyBashCommand(
  command: string,
  overrides: ClassifierOverrides = {},
): Classification {
  const trimmed = command.trim();
  if (!trimmed) return { cacheable: false, reason: "empty command" };

  for (const { pattern, reason } of STRUCTURAL_BLOCKLIST) {
    if (pattern.test(trimmed)) return { cacheable: false, reason };
  }

  // A pipeline is cacheable only if every segment is cacheable on its own.
  const segments = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { cacheable: false, reason: "empty pipeline" };

  const denySet = new Set(overrides.deny ?? []);
  const allowSet = new Set([...READ_ONLY_BASE_COMMANDS, ...(overrides.allow ?? [])]);

  for (const segment of segments) {
    const verdict = classifySegment(segment, allowSet, denySet);
    if (!verdict.cacheable) return verdict;
  }
  return { cacheable: true, reason: "ok" };
}

function classifySegment(
  segment: string,
  allowSet: ReadonlySet<string>,
  denySet: ReadonlySet<string>,
): Classification {
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
        reason: `'${base}' requires a read-only sub-command (got '${sub ?? "<none>"}')`,
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

/**
 * Lightweight argv tokenizer — handles single quotes, double quotes and
 * backslash escapes. Sufficient for the classifier; we do NOT execute the
 * resulting argv anywhere, so edge cases that fall through default to the
 * conservative "not cacheable" branch in the caller.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let mode: "normal" | "single" | "double" = "normal";
  while (i < input.length) {
    const ch = input[i];
    if (mode === "normal") {
      if (ch === "'") { mode = "single"; i++; continue; }
      if (ch === '"') { mode = "double"; i++; continue; }
      if (ch === "\\" && i + 1 < input.length) { cur += input[i + 1]; i += 2; continue; }
      if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } i++; continue; }
      cur += ch; i++; continue;
    }
    if (mode === "single") {
      if (ch === "'") { mode = "normal"; i++; continue; }
      cur += ch; i++; continue;
    }
    if (mode === "double") {
      if (ch === '"') { mode = "normal"; i++; continue; }
      if (ch === "\\" && i + 1 < input.length) { cur += input[i + 1]; i += 2; continue; }
      cur += ch; i++; continue;
    }
  }
  if (cur) out.push(cur);
  return out;
}
