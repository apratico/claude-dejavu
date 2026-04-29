// esbuild entrypoint: bundles the hook scripts and the CLI into single-file
// JS so the plugin install can run them with bare `node` — no extra build step
// on the user side.
import { build, context } from "esbuild";
import { mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // ESM with native deps requires .cjs banner — better-sqlite3 only loads via require.
  // We compile to CJS to keep node-gyp built bindings happy.
  banner: {},
  external: ["better-sqlite3", "pino", "pino-pretty"],
  logLevel: "info",
  legalComments: "none",
};

const targets = [
  { entryPoints: ["src/hooks/pre-tool-use.ts"],  outfile: "hooks/pre-tool-use.js" },
  { entryPoints: ["src/hooks/post-tool-use.ts"], outfile: "hooks/post-tool-use.js" },
  { entryPoints: ["src/hooks/setup.ts"],          outfile: "hooks/setup.js" },
  { entryPoints: ["src/cli.ts"],                  outfile: "scripts/cli.js" },
];

mkdirSync("hooks",   { recursive: true });
mkdirSync("scripts", { recursive: true });

// Switch format to cjs because better-sqlite3 is CommonJS-native.
const opts = (t) => ({ ...common, ...t, format: "cjs" });

if (watch) {
  for (const t of targets) {
    const ctx = await context(opts(t));
    await ctx.watch();
  }
  console.log("[esbuild] watching…");
} else {
  await Promise.all(targets.map((t) => build(opts(t))));
  console.log("[esbuild] built", targets.map((t) => t.outfile).join(", "));
}
