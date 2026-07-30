# MyPath

Local-solo **AI canvas + generation + design engine** workspace.

No accounts, billing, multi-tenant SaaS, or analytics.

Forged from MagicPath public surface (tldraw canvas, revision jobs, design systems, magicpath-ai CLI contracts, agent-skills methodology) and rebuilt to run offline on your machine.

## Quick start

```bash
git clone https://github.com/KcAnom/mypath.git
cd mypath
npm ci
npm start
# open the loopback URL printed by the server
```

Desktop (Tauri, Apple Silicon):

```bash
npm run desktop:build
open src-tauri/target/release/bundle/macos/MyPath.app
```

Local desktop builds are unsigned. Copy the built app to `/Applications` for normal Launchpad or Spotlight access.

## What works locally

| Surface | Behavior |
|---------|----------|
| **Canvas** | Infinite board per project (pan/zoom/drag shapes) |
| **Generate** | Prompt → component + revision + forge files + shape on canvas |
| **Revisions** | Edit code, save new revision |
| **Design systems** | Tokens + designer prompt + markdown |
| **Skills / chat / libraries** | Versioned local design context, parallel project jobs, and exact-revision reuse |
| **Web references** | HTTPS-only full-page import, inert sanitized HTML, optional approved image ingestion, and semantic conversion into runnable React revisions |
| **Surgical capture** | One selected DOM subtree via a short-lived, exact-origin, single-use Chrome extension ticket |
| **Search** | Disabled-by-default providers, per-request opt-in, immutable results/fetched context, and explicit untrusted-reference provenance |
| **Figma exchange** | Deterministic `FigmaExchangeV1` fixture/plugin import and revision export without OAuth |
| **Export / agents** | Reproducible runnable ZIPs and separately authorized local external-agent candidate review |
| **Persistence** | SQLite/WAL with one-time checksummed `db.json` import and immutable import/exchange provenance |

## Generation

Default provider is a **local template** in `server/generate.js`.
Replace `generateComponent()` with Ollama / OpenAI / Anthropic for real model output.

Forge files land in `data/forge/<componentId>/` using MagicPath’s boundary. Absolute paths, traversal, paths outside this allowlist, and symlink escapes are rejected:

- `src/App.tsx`
- `src/index.css`
- `src/components/generated/**`

## Web import, capture, search, and Figma setup

Open a project canvas and choose **Import web page or capture element**. Full-page import accepts only credential-free HTTPS URLs. It stores response provenance, final URL, bounded redirect history, diagnostics, a rights warning, and sanitized HTML. Optional image ingestion is separately selected and accepts at most eight bounded, inspected local assets. **Convert into runnable design** creates a normal candidate/build/revision; imported markup is never mounted or executed.

Surgical capture extension:

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select `extensions/web-capture/`.
3. In MyPath, create a ticket for the page's exact HTTPS origin.
4. Open that page and paste the displayed MyPath origin, ticket ID, and one-time token into the extension.
5. Click **Select element**, then click one element on the page. MyPath polls the ticket and confirms receipt.

The extension has `activeTab` access and loopback MyPath host permissions only. It sends the bounded selected subtree, an allowlist of computed styles, a visible-tab screenshot, and approved MyPath asset IDs. It does not install a persistent all-pages content script. Tickets expire in 30–300 seconds, are single-use, and the server's narrow Chrome-extension-origin exception applies only to the ticket submission route—not general API CORS.

Search providers are configured in the project’s **Web references and exchange** screen. Every search and every result fetch requires a separate explicit opt-in. Stored text is labeled `untrusted_reference`; it can be quoted as reference context but cannot supply system or tool instructions. The included fixture provider is deterministic rather than a general web search engine. Endpoint providers must return bounded JSON results and use the same HTTPS/SSRF boundary.

For Figma, import `extensions/figma-plugin/manifest.json` as a development plugin. Copy/paste `FigmaExchangeV1` JSON between the plugin and MyPath. The format covers frame hierarchy, text, fills, strokes, effects, assets, typography, and auto-layout. `test/fixtures/figma-exchange-v1.json` is the deterministic acceptance path; no live OAuth is configured.

All remote fetch paths use credential-free HTTPS, block private/loopback/link-local/reserved IP space, validate DNS before and again at socket creation, revalidate every redirect, and enforce redirect, header, compressed, decompressed, response, and timeout limits. Cookies, authorization headers, remote script execution, remote CSS imports, and ambient credentials are not used.

Phase 7 verification:

```bash
npm run verify:phase7
npm run test:security -- web-import-ssrf-sanitize
npm run test:integration -- semantic-import-job
npm run test:integration -- capture-ticket
npm run test:integration -- search-provenance
npm run test:integration -- figma-roundtrip-fixtures
npm run test:e2e:prod -- web-import-convert
npm run test:e2e:prod -- surgical-capture
```

## Toolchest

Aggressive extract + contracts: `~/mypath-toolchest/`

- `18-canvas` — events + shape model (tldraw stack notes)
- `19-generation` — revision/job API + provider interface
- `20-design-engine` — themes + Tailwind v4 forge CSS
- `21-cli-bridge` — magicpath-ai command map
- `_source/agent-skills` — upstream agent methodology
- `_source/magicpath-ai-cli` — CLI 2.6.1

## Local API safety and recovery

The browser bootstraps a short-lived same-origin session at `/api/session` and sends `X-MyPath-Session` on API calls. The server binds only to loopback and rejects non-loopback `Host`, cross-origin, and cross-site fetch-metadata requests. These controls protect against browser-origin attacks; they do not protect against another malicious process running as the same OS user.

Development uses `data/` (or `MYPATH_DATA_DIR`). Packaged release builds use `~/Library/Application Support/local.mypath.desktop`. On first open, legacy `db.json` is imported transactionally and archived unchanged after its checksum is committed.

```bash
npm run backup:create -- --label before-change
npm run backup:verify -- --latest
# stop MyPath before restore
npm run backup:restore -- --backup data/backups/<backup>
# backups contain a verified SQLite snapshot plus checksummed blobs/assets/forge/artifact trees
```

## Honest limits / not included

- Sanitization and semantic conversion are deterministic and intentionally conservative; they do not promise pixel-perfect reproduction of arbitrary sites, dynamic application state, videos, web fonts, canvas/WebGL, interactions, or authenticated pages.
- The capture screenshot is the visible browser tab, not a full-page browser automation capture. Only the selected subtree is semantically captured.
- Search has a deterministic fixture and a generic explicitly configured JSON endpoint adapter; MyPath does not bundle or proxy a commercial search account.
- Figma integration is an offline exchange/plugin path. Live OAuth, team-file synchronization, unsupported Figma paint types, and exact roundtripping of every Figma feature are not provided.
- Imported material remains the user's rights responsibility even after sanitization or conversion.
- Liveblocks multiplayer, hosted LLM service, billing, accounts, organizations, and admin surfaces are not included.
- `build:prod` stages the exact `.node-version` executable as the bundled Node sidecar, compiled `.runtime/web`, server, production dependencies, and a SHA-256 runtime manifest. `desktop:smoke:clean` exercises that staged runtime with a clean PATH, a fixed-port decoy, and an authenticated dynamic-port descriptor. Local builds are not signed, notarized, or VM-verified unless those steps are performed separately.
