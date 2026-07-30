# MyPath desktop (Tauri 2 + WKWebView)

Mac-only thin shell. Uses **OS WebView** (no Electron/Chromium).

## Behavior
1. Resolve the staged packaged runtime or development project root.
2. Use the pinned bundled Node sidecar in release builds.
3. Spawn an owned backend on a dynamic loopback port.
4. Authenticate startup through a one-time HMAC descriptor and desktop instance nonce.
5. Open the authenticated loopback URL in WKWebView.
6. On quit, stop only the server process owned by this app instance.

A narrow Tauri command bridge handles native export destinations and allowlisted IDE launch. All other application traffic uses the authenticated loopback API.

## Commands
```bash
# from repo root
npm run desktop             # development
npm run desktop:build       # unsigned local .app
npm run desktop:smoke:clean # build and smoke the actual bundle
```

Development env:
- `MYPATH_ROOT` — optional project-root override
- `MYPATH_NODE` — optional Node binary override
- `MYPATH_API_PORT` — optional debug port; release builds always choose a dynamic port

## Note on Swift
`macos/` has a Swift WKWebView implementation, but this machine's Command Line Tools Swift SDK is mismatched. Tauri is the working shell.
