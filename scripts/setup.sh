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

if ! command -v npm >/dev/null 2>&1; then
  echo "claude-dejavu: npm not found in PATH; cannot install runtime deps" >&2
  exit 1
fi

# Always run install — `claude plugin install` may have skipped postinstall
# scripts (and therefore the native node-gyp build for better-sqlite3),
# leaving an unusable `node_modules/`. `npm install` is idempotent and cheap
# when the tree is already complete.
npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null

# Verify the better-sqlite3 native binding was actually produced; if the
# prebuild fetch was blocked or the local toolchain failed silently, force a
# fresh rebuild from source. This is the pattern that bites users on the
# `claude plugin install` path because it disables postinstall hooks by default.
BINDING="$PLUGIN_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$BINDING" ]; then
  echo "claude-dejavu: better-sqlite3 native binding missing, rebuilding from source…" >&2
  npm rebuild better-sqlite3 --build-from-source --loglevel=error >/dev/null || {
    echo "claude-dejavu: rebuild failed — install GCC / python3 / make and retry 'claude plugin update claude-dejavu@apratico'" >&2
    exit 1
  }
fi

mkdir -p "$DATA_DIR/logs"

echo "claude-dejavu: ready (data at $DATA_DIR)"
