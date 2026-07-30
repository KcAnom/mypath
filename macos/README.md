# MyPath macOS shell

Swift + **WKWebView** (no Electron, no Chromium).

## Behavior
1. Resolve project root (`MYPATH_ROOT` or walk from binary / cwd)
2. Find `node`
3. Spawn `node server/index.js` if `/health` is not already up
4. Open `http://127.0.0.1:8787` in WKWebView
5. On quit, SIGTERM the server **only if this app started it**

## Commands
```bash
./run-dev.sh          # debug build + run
./build-app.sh        # release → ../dist/MyPath.app
```

No `window.mypathDesktop` bridge — web UI does not depend on it.
