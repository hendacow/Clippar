#!/usr/bin/env bash
# One command: build what is missing, refresh the manifest, run the bench.
set -euo pipefail
BENCH="$(cd "$(dirname "$0")" && pwd)"
"$BENCH/build.sh"
python3 "$BENCH/manifest.py"
exec python3 "$BENCH/bench.py" "$@"
