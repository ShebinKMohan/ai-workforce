#!/bin/bash
# mkwrapper.sh <wrapper-path> <scenario-path>
set -euo pipefail
WRAP="$1"; SCEN="$2"; REAL="$3"
cat > "$WRAP" <<EOF
#!/usr/bin/env node
// Thin wrapper: pins one deterministic scenario onto the shipped fake runtime.
// The shipped script is imported unchanged; only argv is prepared for it.
process.argv.splice(2, 0, '--scenario', ${SCENQ:-}'$SCEN');
await import('file://$REAL');
EOF
chmod +x "$WRAP"
