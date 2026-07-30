#!/usr/bin/env bash
# Compatibility entry point. Runtime resources are generated under ignored .runtime
# and referenced directly by tauri.conf.json; source and dist trees are never patched.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build:prod
