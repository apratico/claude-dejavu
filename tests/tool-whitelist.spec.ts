import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/load.js";
import {
  classifyToolCall,
  extractInvalidationPath,
  ttlForBucket,
} from "../src/policy/tool-whitelist.js";

describe("classifyToolCall", () => {
  test("Read with file_path is cacheable and feeds mtimeFiles", () => {
    const v = classifyToolCall("Read", { file_path: "/tmp/x" }, "/", DEFAULT_CONFIG);
    expect(v.cacheable).toBe(true);
    expect(v.mtimeFiles).toEqual(["/tmp/x"]);
    expect(v.ttlBucket).toBe("read");
  });

  test("Read without file_path is not cacheable", () => {
    const v = classifyToolCall("Read", {}, "/", DEFAULT_CONFIG);
    expect(v.cacheable).toBe(false);
  });

  test("Grep is TTL-only, no mtime files", () => {
    const v = classifyToolCall("Grep", { pattern: "x", path: "/" }, "/", DEFAULT_CONFIG);
    expect(v.cacheable).toBe(true);
    expect(v.mtimeFiles).toEqual([]);
    expect(v.ttlBucket).toBe("grep");
  });

  test("Glob is TTL-only", () => {
    const v = classifyToolCall("Glob", { pattern: "**/*.ts" }, "/", DEFAULT_CONFIG);
    expect(v.cacheable).toBe(true);
    expect(v.ttlBucket).toBe("grep");
  });

  test("Bash gates through bash-classifier", () => {
    const ok = classifyToolCall("Bash", { command: "ls -la" }, "/", DEFAULT_CONFIG);
    const no = classifyToolCall("Bash", { command: "rm -rf /" }, "/", DEFAULT_CONFIG);
    expect(ok.cacheable).toBe(true);
    expect(no.cacheable).toBe(false);
  });

  test("disabledTools opt-out wins", () => {
    const cfg = { ...DEFAULT_CONFIG, disabledTools: ["Read"] };
    const v = classifyToolCall("Read", { file_path: "/x" }, "/", cfg);
    expect(v.cacheable).toBe(false);
  });

  test("plugin disabled blanket-rejects everything", () => {
    const cfg = { ...DEFAULT_CONFIG, enabled: false };
    const v = classifyToolCall("Read", { file_path: "/x" }, "/", cfg);
    expect(v.cacheable).toBe(false);
  });

  test("non-supported tool rejected by default", () => {
    const v = classifyToolCall("WebFetch", { url: "https://x" }, "/", DEFAULT_CONFIG);
    expect(v.cacheable).toBe(false);
  });
});

describe("extractInvalidationPath", () => {
  test("Edit yields absolute path", () => {
    expect(extractInvalidationPath("Edit", { file_path: "/abs/x.ts" }, "/cwd")).toBe("/abs/x.ts");
  });
  test("Write resolves relative path against cwd", () => {
    expect(extractInvalidationPath("Write", { file_path: "rel.ts" }, "/cwd"))
      .toBe("/cwd/rel.ts");
  });
  test("MultiEdit included", () => {
    expect(extractInvalidationPath("MultiEdit", { file_path: "/x" }, "/")).toBe("/x");
  });
  test("non-mutating tool returns null", () => {
    expect(extractInvalidationPath("Read", { file_path: "/x" }, "/")).toBeNull();
  });
});

describe("ttlForBucket", () => {
  test("maps each bucket to the configured value", () => {
    const cfg = { ...DEFAULT_CONFIG, ttl: { read: 0, grep: 60, bash: 3600 } };
    expect(ttlForBucket("read", cfg)).toBe(0);
    expect(ttlForBucket("grep", cfg)).toBe(60);
    expect(ttlForBucket("bash", cfg)).toBe(3600);
    expect(ttlForBucket("none", cfg)).toBe(0);
  });
});
