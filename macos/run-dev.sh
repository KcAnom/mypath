#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/macos"
swift build -c debug --product MyPathApp
BIN="$(swift build -c debug --show-bin-path)/MyPathApp"
export MYPATH_ROOT="$ROOT"
export MYPATH_API_PORT="${MYPATH_API_PORT:-8787}"
exec "$BIN"
