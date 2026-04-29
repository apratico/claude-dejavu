import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CacheStore, nowSeconds } from "../src/cache/store.js";

let dir: string;
let store: CacheStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dejavu-cache-"));
  store = new CacheStore(join(dir, "cache.db"), { maxRows: 5 });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CacheStore", () => {
  test("put then get returns the same value", () => {
    store.put("h1", "Read", "hello world", { toolInputJson: "{}" });
    const entry = store.get("h1");
    expect(entry).toBeDefined();
    expect(entry?.value).toBe("hello world");
    expect(entry?.toolName).toBe("Read");
    expect(entry?.hits).toBe(1);
  });

  test("get returns undefined for unknown key", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  test("ttl-expired entry is evicted on read", () => {
    const past = nowSeconds() - 10;
    store.put("h2", "Bash", "out", { ttlSeconds: 5 }, past);
    expect(store.get("h2")).toBeUndefined();
  });

  test("hits counter increments on every successful get", () => {
    store.put("h3", "Read", "x");
    store.get("h3");
    store.get("h3");
    const e = store.get("h3");
    expect(e?.hits).toBe(3);
  });

  test("invalidateByTool drops only that tool's rows", () => {
    store.put("a", "Read", "x");
    store.put("b", "Grep", "y");
    store.put("c", "Read", "z");
    expect(store.invalidateByTool("Read")).toBe(2);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
  });

  test("invalidateAll wipes everything", () => {
    store.put("a", "Read", "x");
    store.put("b", "Grep", "y");
    expect(store.invalidateAll()).toBe(2);
    expect(store.stats().totalRows).toBe(0);
  });

  test("invalidateReadsForPath removes Read entries that mention the path", () => {
    store.put("a", "Read", "v", { toolInputJson: JSON.stringify({ file_path: "/repo/foo.ts" }) });
    store.put("b", "Read", "v", { toolInputJson: JSON.stringify({ file_path: "/repo/bar.ts" }) });
    store.put("c", "Grep", "v", { toolInputJson: JSON.stringify({ pattern: "x" }) });
    const dropped = store.invalidateReadsForPath("/repo/foo.ts");
    expect(dropped).toBe(1);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBeDefined();
    expect(store.get("c")).toBeDefined();
  });

  test("LRU eviction kicks in past maxRows", () => {
    for (let i = 0; i < 7; i++) {
      // Touch each existing entry first, so the very oldest ones are evicted.
      store.put(`h${i}`, "Read", "x".repeat(10), {}, nowSeconds() + i);
    }
    expect(store.stats().totalRows).toBeLessThanOrEqual(5);
  });

  test("stats reports per-tool aggregates", () => {
    store.put("a", "Read",  "12345");
    store.put("b", "Read",  "67");
    store.put("c", "Bash",  "abcdef");
    const s = store.stats();
    expect(s.totalRows).toBe(3);
    const read = s.perTool.find((t) => t.toolName === "Read");
    expect(read?.rows).toBe(2);
  });
});
