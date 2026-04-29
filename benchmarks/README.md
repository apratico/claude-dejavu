# claude-dejavu benchmarks

A small reproducible harness that quantifies the token savings claude-dejavu
brings on representative Claude Code sessions.

## What it measures

Each benchmark scenario is a sequence of synthetic tool invocations that
matches a real session pattern (heavy `Read`, repeated `git log`, broad
`Grep`, etc.). The harness runs the sequence twice:

1. **Baseline** — every tool call executes; tool outputs are captured verbatim.
2. **With dejavu** — the same sequence runs through the PreToolUse / PostToolUse
   hook pair (in-process, no real Claude Code runtime needed).

For each run the harness reports:

- total tool invocations
- cache hits / misses
- bytes of tool output that would land in the context window
- estimated input-token equivalent (4 chars ≈ 1 token, conservative)
- wall-clock latency per invocation

## How to run

```bash
git clone https://github.com/apratico/claude-dejavu
cd claude-dejavu
npm install
npm run build
npm run benchmark
```

The harness writes a JSON report to `benchmarks/results/<timestamp>.json` and
prints a human-readable summary to stdout.

## Scenarios

| Scenario               | Description                                                                  |
|------------------------|------------------------------------------------------------------------------|
| `read-loop`            | Reads `package.json` 30 times (simulates "what's the entrypoint again?").     |
| `git-status-spam`      | Alternates `git status` / `git log --oneline -20` 50 times across 1 mutation.|
| `wide-grep`            | Repeats the same `Grep` query against a 10k-file corpus 10 times.            |
| `mixed-refactor-2h`    | Real anonymized session trace from a 2-hour TypeScript refactor.             |

Scenarios are defined under `benchmarks/scenarios/`. Drop a new
`<name>.json` to add one — the harness picks up everything matching
`scenarios/*.json`.
