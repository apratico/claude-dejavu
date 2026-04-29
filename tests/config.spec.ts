import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../src/config/load.js";

describe("mergeConfig", () => {
  test("returns defaults when override is empty", () => {
    expect(mergeConfig(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
  });

  test("override partially overrides ttl bucket without touching the others", () => {
    const m = mergeConfig(DEFAULT_CONFIG, { ttl: { bash: 60 } as { bash: number; read: number; grep: number } });
    expect(m.ttl.bash).toBe(60);
    expect(m.ttl.read).toBe(DEFAULT_CONFIG.ttl.read);
    expect(m.ttl.grep).toBe(DEFAULT_CONFIG.ttl.grep);
  });

  test("bash.allow / bash.deny are concatenated and deduped", () => {
    const m = mergeConfig(
      { ...DEFAULT_CONFIG, bash: { allow: ["foo"], deny: ["bar"] } },
      { bash: { allow: ["foo", "baz"], deny: ["bar", "qux"] } },
    );
    expect(m.bash.allow).toEqual(["foo", "baz"]);
    expect(m.bash.deny).toEqual(["bar", "qux"]);
  });

  test("disabledTools deduped", () => {
    const m = mergeConfig(
      { ...DEFAULT_CONFIG, disabledTools: ["Read"] },
      { disabledTools: ["Read", "Bash"] },
    );
    expect(m.disabledTools).toEqual(["Read", "Bash"]);
  });

  test("scalar overrides win", () => {
    const m = mergeConfig(DEFAULT_CONFIG, { enabled: false, maxRows: 10 });
    expect(m.enabled).toBe(false);
    expect(m.maxRows).toBe(10);
  });
});

describe("loadConfig", () => {
  test("missing file → defaults", () => {
    expect(loadConfig("/no/such/path.json")).toEqual(DEFAULT_CONFIG);
  });

  test("malformed JSON → defaults (must not throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{not json");
    try {
      expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid override is merged", () => {
    const dir = mkdtempSync(join(tmpdir(), "dejavu-cfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ enabled: false, ttl: { bash: 60 } }));
    try {
      const cfg = loadConfig(path);
      expect(cfg.enabled).toBe(false);
      expect(cfg.ttl.bash).toBe(60);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
