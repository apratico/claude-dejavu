/**
 * Helpers for the Claude Code hook protocol: read JSON from stdin, write JSON
 * to stdout, format the canonical hookSpecificOutput envelope.
 */

export interface PreToolUseInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_use_id?: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_use_id?: string;
  tool_input: Record<string, unknown>;
  /** Newer Claude Code versions; older ones may use `tool_response`. */
  tool_output?: unknown;
  tool_response?: unknown;
}

export type PermissionDecision = "allow" | "deny" | "ask" | "defer";

export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: PermissionDecision;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

export interface PostToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
}

export async function readJsonStdin<T>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty stdin");
  return JSON.parse(raw) as T;
}

export function writeJsonStdout(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload));
}

/** Build the no-op "allow" PreToolUse response. Hooks fall back to this on any error. */
export function allowPre(): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

export function denyPreWithCachedContext(reason: string, additionalContext: string): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext,
    },
  };
}
