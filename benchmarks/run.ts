/**
 * Benchmark harness skeleton — runs each scenario twice (baseline vs cache)
 * and reports token-equivalent and wall-clock deltas.
 *
 * v0.1 ships the harness shell + the read-loop scenario. Additional scenarios
 * live under benchmarks/scenarios/*.json and are picked up automatically.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CacheStore } from "../src/cache/store.js";
import { buildKey } from "../src/cache/key.js";
import { DEFAULT_CONFIG } from "../src/config/load.js";
import { classifyToolCall, ttlForBucket } from "../src/policy/tool-whitelist.js";

interface ScenarioStep {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Verbatim text the tool would have returned. */
  toolOutput: string;
}

interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

interface Report {
  scenario: string;
  steps: number;
  hits: number;
  misses: number;
  bytesBaseline: number;
  bytesWithCache: number;
  saved: { bytes: number; pctTokens: number };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = join(HERE, "scenarios");
const RESULTS = join(HERE, "results");

function loadScenarios(): Scenario[] {
  return readdirSync(SCENARIOS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SCENARIOS, f), "utf8")) as Scenario);
}

function runScenario(scenario: Scenario): Report {
  const dbPath = join(mkdtempSync(join(tmpdir(), "dejavu-bench-")), "cache.db");
  const store = new CacheStore(dbPath);

  let hits = 0;
  let bytesBaseline = 0;
  let bytesWithCache = 0;

  for (const step of scenario.steps) {
    bytesBaseline += Buffer.byteLength(step.toolOutput, "utf8");
    const verdict = classifyToolCall(step.toolName, step.toolInput, "/", DEFAULT_CONFIG);
    if (!verdict.cacheable) {
      bytesWithCache += Buffer.byteLength(step.toolOutput, "utf8");
      continue;
    }
    const { hash } = buildKey({
      toolName: step.toolName,
      toolInput: step.toolInput,
      cwd: "/",
      mtimeFiles: verdict.mtimeFiles,
    });
    if (store.get(hash)) {
      hits++;
      // The cached additionalContext is roughly the original output plus the
      // marker preamble — the v0.1 win is on tool exec / I/O, not bytes.
      bytesWithCache += Buffer.byteLength(step.toolOutput, "utf8") + 256;
    } else {
      bytesWithCache += Buffer.byteLength(step.toolOutput, "utf8");
      store.put(hash, step.toolName, step.toolOutput, {
        ttlSeconds: ttlForBucket(verdict.ttlBucket, DEFAULT_CONFIG),
        toolInputJson: JSON.stringify(step.toolInput),
      });
    }
  }

  store.close();
  rmSync(dirname(dbPath), { recursive: true, force: true });

  const savedBytes = bytesBaseline - bytesWithCache;
  return {
    scenario: scenario.name,
    steps: scenario.steps.length,
    hits,
    misses: scenario.steps.length - hits,
    bytesBaseline,
    bytesWithCache,
    saved: {
      bytes: savedBytes,
      pctTokens: bytesBaseline === 0 ? 0 : (savedBytes / bytesBaseline) * 100,
    },
  };
}

function main(): void {
  mkdirSync(RESULTS, { recursive: true });
  const scenarios = loadScenarios();
  const reports = scenarios.map(runScenario);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS, `${ts}.json`);
  writeFileSync(out, JSON.stringify({ generatedAt: ts, reports }, null, 2));

  console.log("claude-dejavu benchmark report");
  console.log("=".repeat(40));
  for (const r of reports) {
    console.log(
      `${r.scenario.padEnd(24)}  steps=${r.steps}  hits=${r.hits}  miss=${r.misses}` +
        `  bytes_baseline=${r.bytesBaseline}  bytes_cached=${r.bytesWithCache}` +
        `  saved=${r.saved.pctTokens.toFixed(1)}%`,
    );
  }
  console.log(`\nfull report: ${out}`);
}

main();
