#!/usr/bin/env bash
# Build MyPath.app (Swift + WKWebView shell)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS_DIR="$ROOT/macos"
BUILD_DIR="$MACOS_DIR/.build"
APP_DIR="$ROOT/dist/MyPath.app"
BIN_NAME="MyPathApp"

cd "$MACOS_DIR"
echo "→ swift build (release)"
swift build -c release --product MyPathApp

BIN="$(swift build -c release --show-bin-path)/$BIN_NAME"
if [[ ! -x "$BIN" ]]; then
  echo "error: binary not found at $BIN" >&2
  exit 1
fi

echo "→ assemble $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources/mypath"

# Binary
cp "$BIN" "$APP_DIR/Contents/MacOS/MyPath"
chmod +x "$APP_DIR/Contents/MacOS/MyPath"

# Bundle project runtime (server + web). Data stays outside or first-run.
rsync -a --delete \
  --exclude node_modules --exclude data --exclude dist --exclude desktop \
  --exclude macos/.build --exclude .git \
  "$ROOT/server" "$ROOT/web" "$ROOT/package.json" "$ROOT/packages" \
  "$APP_DIR/Contents/Resources/mypath/" 2>/dev/null || true

# Ensure server/web always present even if packages missing
mkdir -p "$APP_DIR/Contents/Resources/mypath"
rsync -a "$ROOT/server/" "$APP_DIR/Contents/Resources/mypath/server/"
rsync -a "$ROOT/web/" "$APP_DIR/Contents/Resources/mypath/web/"
cp "$ROOT/package.json" "$APP_DIR/Contents/Resources/mypath/package.json"

# Info.plist
cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MyPath</string>
  <key>CFBundleDisplayName</key><string>MyPath</string>
  <key>CFBundleIdentifier</key><string>local.mypath.app</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>MyPath</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoads</key><true/>
  </dict>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

# PkgInfo
echo -n 'APPL????' > "$APP_DIR/Contents/PkgInfo"

echo "✓ Built: $APP_DIR"
echo "  Run: open \"$APP_DIR\""
echo "  Or dev: cd \"$ROOT\" && MYPATH_ROOT=\"$ROOT\" \"$BIN\""
