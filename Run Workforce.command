#!/bin/sh
set -eu
WORKFORCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if "$WORKFORCE_ROOT/run.sh" "$@"; then
  exit 0
else
  result=$?
  printf '\n%s' 'Press Return to close this window… '
  read -r response || true
  exit "$result"
fi
