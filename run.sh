#!/bin/sh
# Start the complete local Workforce app from any working directory.
set -eu

WORKFORCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$WORKFORCE_ROOT"

WORKFORCE_NODE_BIN=''
for candidate in "${WORKFORCE_NODE:-}" "$(command -v node 2>/dev/null || true)" \
  /opt/homebrew/bin/node /usr/local/bin/node \
  "${HOME:-}/.volta/bin/node" "${HOME:-}/.local/bin/node" \
  "${HOME:-}/.nvm/versions/node/"*/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && \
    "$candidate" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22 || (major===22 && minor>=13) ? 0 : 1)' >/dev/null 2>&1; then
    WORKFORCE_NODE_BIN=$candidate
    break
  fi
done

if [ -z "$WORKFORCE_NODE_BIN" ]; then
  printf '%s\n' 'AI Workforce needs Node.js 22.13 or newer. Install Node.js, then open this launcher again.' >&2
  exit 1
fi

PATH="$(dirname -- "$WORKFORCE_NODE_BIN"):${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH
exec "$WORKFORCE_NODE_BIN" "$WORKFORCE_ROOT/scripts/run.mjs" "$@"
