#!/usr/bin/env bash
# claude-dejavu Setup hook
#
# Runs once when the plugin is installed. Responsible for:
#   1. Installing the runtime dependencies (better-sqlite3 native binding, pino).
#   2. Creating the data directory at ~/.claude-dejavu/.
#
# Idempotent: re-running is safe; npm install short-circuits on no-op.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_DEJAVU_HOME:-$HOME/.claude-dejavu}"

cd "$PLUGIN_ROOT"

if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
  if command -v npm >/dev/null 2>&1; then
    npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
  else
    echo "claude-dejavu: npm not found in PATH; cannot install runtime deps" >&2
    exit 1
  fi
fi

mkdir -p "$DATA_DIR"

echo "claude-dejavu: ready (data at $DATA_DIR)"
