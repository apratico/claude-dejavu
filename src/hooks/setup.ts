/**
 * Setup hook — runs once on plugin install. Initializes the data directory
 * and creates the SQLite cache file (and its WAL companions). Idempotent.
 *
 * Most of the heavy lifting (npm install for native binaries) is handled by
 * scripts/setup.sh; this hook only deals with what JS code can do safely.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CacheStore } from "../cache/store.js";
import { log, withErrorLogging } from "../log.js";

void withErrorLogging("setup", async () => {
  const dataDir = process.env.CLAUDE_DEJAVU_HOME ?? join(homedir(), ".claude-dejavu");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const dbPath = join(dataDir, "cache.db");
  const store = new CacheStore(dbPath);
  store.close();
  log.info({ dataDir, dbPath }, "claude-dejavu setup completed");
  process.stdout.write("claude-dejavu: ready\n");
});
