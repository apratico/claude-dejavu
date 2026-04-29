import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKey, canonicalizeJson } from "../src/cache/key.js";

describe("canonicalizeJson", () => {
  test("sorts object keys recursively", () => {
    const a = canonicalizeJson({ b: 2, a: { y: 1, x: 2 } });
    const b = canonicalizeJson({ a: { x: 2, y: 1 }, b: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("preserves array order", () => {
    const v = canonicalizeJson([3, 1, 2]);
    expect(v).toEqual([3, 1, 2]);
  });

  test("passes through scalars", () => {
    expect(canonicalizeJson(42)).toBe(42);
    expect(canonicalizeJson("x")).toBe("x");
    expect(canonicalizeJson(null)).toBeNull();
    expect(canonicalizeJson(true)).toBe(true);
  });
});

describe("buildKey", () => {
  test("identical inputs → identical hashes", () => {
    const a = buildKey({ toolName: "Read", toolInput: { file_path: "/x" }, cwd: "/", mtimeFiles: [] });
    const b = buildKey({ toolName: "Read", toolInput: { file_path: "/x" }, cwd: "/", mtimeFiles: [] });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(64);
  });

  test("argument key order does not matter", () => {
    const a = buildKey({
      toolName: "Grep",
      toolInput: { pattern: "x", path: "/y", multiline: true },
      cwd: "/",
      mtimeFiles: [],
    });
    const b = buildKey({
      toolName: "Grep",
      toolInput: { multiline: true, path: "/y", pattern: "x" },
      cwd: "/",
      mtimeFiles: [],
    });
    expect(a.hash).toBe(b.hash);
  });

  test("different tools produce different hashes for same args", () => {
    const a = buildKey({ toolName: "Read", toolInput: { file_path: "/x" }, cwd: "/", mtimeFiles: [] });
    const b = buildKey({ toolName: "Grep", toolInput: { file_path: "/x" }, cwd: "/", mtimeFiles: [] });
    expect(a.hash).not.toBe(b.hash);
  });

  test("relative paths in mtimeFiles resolve against cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-key-"));
    try {
      writeFileSync(join(dir, "a.txt"), "hello");
      const abs = buildKey({
        toolName: "Read",
        toolInput: { file_path: join(dir, "a.txt") },
        cwd: dir,
        mtimeFiles: [join(dir, "a.txt")],
      });
      const rel = buildKey({
        toolName: "Read",
        toolInput: { file_path: join(dir, "a.txt") },
        cwd: dir,
        mtimeFiles: ["a.txt"],
      });
      expect(rel.hash).toBe(abs.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file mtime change invalidates the hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-key-"));
    try {
      const file = join(dir, "f.txt");
      writeFileSync(file, "v1");
      const before = buildKey({
        toolName: "Read",
        toolInput: { file_path: file },
        cwd: dir,
        mtimeFiles: [file],
      });

      // Force mtime change to a clearly-different second.
      const future = new Date();
      future.setSeconds(future.getSeconds() + 5);
      utimesSync(file, future, future);

      const after = buildKey({
        toolName: "Read",
        toolInput: { file_path: file },
        cwd: dir,
        mtimeFiles: [file],
      });
      expect(after.hash).not.toBe(before.hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file is encoded as absent rather than throwing", () => {
    const r = buildKey({
      toolName: "Read",
      toolInput: { file_path: "/no/such/path" },
      cwd: "/",
      mtimeFiles: ["/no/such/path"],
    });
    const present = r.canonical.mtimes[0];
    expect(present.mtimeNs).toBeNull();
  });
});
