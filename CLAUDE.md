# MyPath — agent notes

## GitHub identity

**Push as `KcAnom`.** Two accounts are logged in on this machine; only `KcAnom` has
push rights here (`elev8tion` is pull-only and 403s). `KcAnom` is the active `gh`
account, so plain `git push` just works. If a push ever 403s, the fix is one command:

```bash
gh auth switch -u KcAnom
```

Do not add per-repo credential helpers or put a username in the remote URL — that
was tried, and it is strictly more complexity than switching the active account.

**Commit authorship is separate and should not be changed.** Every commit here is
authored `kcdacre8tor <156138628+elev8tion@users.noreply.github.com>`, inherited
from global config. Authorship is unrelated to push rights — leave it consistent.

## Build and packaging

- `npm run build:web` — Vite build into `.runtime/web`.
- `npm run build:prod` — build:web, then stage a checksummed production runtime
  into `.runtime/mypath`, then verify it.
- `npm run lint` / `npm run typecheck` — both run over JS and the two TS configs.

The installed `/Applications/MyPath.app` is the **Tauri** build (bundle id
`local.mypath.desktop`), not the Swift shell in `macos/` (`local.mypath.app`).
Its resources are a staged Node runtime described by a sha256
`runtime-manifest.json`, so **never hand-copy files into the bundle** — that
desynchronizes the manifest. To ship web/server changes into the installed app:

```bash
npm run build:prod
rsync -a --delete .runtime/mypath/ "/Applications/MyPath.app/Contents/Resources/resources/mypath/"
```

Do not pipe `rsync` into `head`/`tail` — SIGPIPE kills it mid-copy and leaves the
bundle partially updated. A full `cargo` rebuild is only needed when `src-tauri/`
Rust sources change; web and server changes do not require it.

## UI conventions

- Dark theme only (`color-scheme: dark`). Never introduce light-mode colors.
  Design tokens live in `:root` in `web/styles.css`.
- Status feedback is a discriminated union, never a string prefix check:
  `{ kind: 'error' | 'success' | 'info', text: string } | null`, rendered as
  `className={"status-message " + kind}` with `role="alert"` for errors and
  `role="status"` otherwise. Success and info auto-clear after 6s; errors persist.
- `.diagnostics` is error-only. Never put success text in it.
- One empty-state treatment: `.empty` with a `<strong>` title and a `<span>`
  naming the next action.
