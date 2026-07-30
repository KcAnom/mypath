#!/usr/bin/env bash
# Builds a universal macOS app only when both Rust targets and an explicitly supplied
# pinned universal Node sidecar are available. This does not sign or notarize the app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "desktop:build:universal requires macOS" >&2; exit 2
fi
: "${MYPATH_NODE_SIDECAR:?Set MYPATH_NODE_SIDECAR to a trusted universal Node $(cat .node-version) executable}"
ARCHES="$(/usr/bin/lipo -archs "$MYPATH_NODE_SIDECAR")"
[[ "$ARCHES" == *arm64* && "$ARCHES" == *x86_64* ]] || { echo "Node sidecar is not universal: $ARCHES" >&2; exit 2; }
for TARGET in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$TARGET" || { echo "Missing Rust target: $TARGET (rustup target add $TARGET)" >&2; exit 2; }
done
npm run build:prod
(cd src-tauri && cargo tauri build --target universal-apple-darwin --bundles app --no-sign)
echo "Universal app built locally. It has not been signed, notarized, or VM-verified."
