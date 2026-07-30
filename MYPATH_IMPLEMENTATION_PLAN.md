# Corrected execution plan

## 1. Fixed architecture and delivery rules

1. **Scope**
   - Preserve local-solo operation and Tauri as the only supported desktop shell.
   - Do not implement accounts, billing, organizations, multiplayer, sharing, or hosted execution.
   - Treat `dist/` and `src-tauri/resources/` as generated artifacts.

2. **Packaged runtime decision**
   - Bundle a pinned Node 22 LTS sidecar; packaged MyPath must not use `resolve_node()` or require Node on `PATH`.
   - Build `better-sqlite3` against that exact Node ABI separately for arm64 and x64. Produce a universal sidecar/native module with `lipo`, then sign the Node binary and every `.node` file before signing the app.
   - Start the backend from Tauri `setup`, using `app.path().app_data_dir()`. Store child, PID/log paths, port, and instance secret in managed Rust state.
   - Node binds `127.0.0.1:0`, writes an instance-secret-authenticated startup descriptor, and Tauri navigates to the reported dynamic port. Never trust an existing fixed-port health response.
   - Clarify in documentation: session/origin controls protect against browser-origin attacks, not arbitrary malicious processes running as the same OS user.

3. **Workspace/output layout**
   - Add root npm workspaces: `server`, `web`, `packages/*`.
   - Add `server/package.json`, `web/package.json`, `tsconfig.base.json`, project references, and package-local tsconfigs.
   - Build `@mypath/shared` into `packages/shared/dist`; expose JS and declarations through `exports`, never TypeScript source.
   - Production output:
     - `dist/server/`
     - `dist/web/`
     - `dist/packages/shared/`
     - copied SQL migrations, forge templates, preview runtime, and static assets
     - production-only `node_modules`
   - `scripts/stage-runtime.mjs` copies resources and verifies a checksum manifest. Plain `tsc` is not responsible for resource copying.
   - In development, mount Vite middleware behind Fastify so the browser always uses the backend origin. Production serves `dist/web`.

4. **API/authentication**
   - Canonical routes use `/api/v1/**`; retain existing root-route aliases through Phase 1 with identical schemas and authentication.
   - Keep `/api/session` as the legacy bootstrap alias for `/api/v1/session`.
   - The current `web/app.js` must bootstrap and refresh the session before authentication enforcement.
   - Use `X-MyPath-Session` for API calls and authenticated `fetch()` streaming for events. Do not use native `EventSource` or place the main token in URLs.
   - Validate `Host`, exact `Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`, and the desktop instance nonce. Session tokens expire and refresh through a same-origin bootstrap.
   - Route conformance records method, canonical path, alias, authentication class, request schema, response schema, and compatibility status.

5. **Backup/rollback convention**
   - Before each phase run `npm run backup:create -- --label phase-N`.
   - Before SQLite adoption this copies source plus `data/db.json`. Afterwards it uses SQLite’s backup API; it must not tar a live database/WAL.
   - Restore only while the service is stopped:
     ```bash
     npm run backup:verify -- --latest
     npm run backup:restore -- --backup <path>
     ```
   - Migrations are forward-only. Rollback means restoring both the prior application bundle and verified database backup, not running destructive down migrations.

---

## 2. Architecture spike — packaging must pass before Phase 0

### Deliverables

Modify/add:

- `package.json`, `package-lock.json`, `.node-version`
- `server/package.json`, `web/package.json`
- `packages/shared/package.json`
- `tsconfig.base.json`, package tsconfigs
- `scripts/stage-runtime.mjs`
- `scripts/build-node-sidecar.sh`
- `scripts/build-native-modules.sh`
- `scripts/verify-clean-app.sh`
- `src-tauri/src/main.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

Prove:

- compiled shared-package resolution in production;
- migration/template/preview resource copying;
- Application Support discovery from Tauri `setup`;
- dynamic-port/nonce startup;
- signed arm64, x64, and universal Node/SQLite artifacts;
- packaged operation with an empty `PATH`.

Add dependencies only after this spike validates the pinned Node and `better-sqlite3` versions.

### Acceptance commands

```bash
npm ci
npm run build:prod
npm run spike:sqlite
npm run desktop:build:arm64
npm run desktop:build:x64
npm run desktop:build:universal
codesign --verify --deep --strict --verbose=2 src-tauri/target/universal-apple-darwin/release/bundle/macos/MyPath.app
env -i HOME="$HOME" PATH=/usr/bin:/bin bash scripts/verify-clean-app.sh
```

Release is blocked until the signed app is also tested in clean arm64 and x64 accounts/VMs with no Node installation.

---

## 3. Phase 0 — Compatibility-preserving safety and SQLite migration

### Step 0A: Toolchain and legacy-client compatibility

Add the TypeScript/Fastify server shell, shared Zod contracts, lint/typecheck/Vitest/Playwright configuration, production E2E launcher, and standard error envelope.

Before enforcing authentication, update `web/app.js` to:

- fetch `/api/session`;
- cache and refresh the token;
- send `X-MyPath-Session`;
- retry once after expiry;
- understand the structured error envelope.

Remove Google Fonts from `web/index.html` and `server/generate.js`. New templates use local/system fonts only.

**Milestone gate:** existing project, component, canvas, design-system, library, skill, and chat CRUD still work against the compatibility aliases.

### Step 0B: Security enforcement

Add:

- `server/src/security/{session,origin,fetch-metadata,body-limits,forge-path,csp}.ts`
- strict loopback binding, Host/origin checks, instance nonce verification;
- 1 MiB default JSON and 256 KiB chat/context limits;
- multipart per-file and aggregate limits, bounded part counts, and cleanup on rejection/disconnect;
- forge path/symlink validation;
- restrictive app and preview CSPs.

Generated sources may import only:

- approved React/runtime packages;
- relative files inside the candidate;
- approved local assets.

Reject Node built-ins, arbitrary packages, dynamic remote imports, remote CSS `@import`, generated Vite plugins, and package installation. Enforce source/output limits, build timeout, memory limit, abort propagation, and process-group termination.

### Step 0C: SQLite/WAL and exact legacy import

Add `server/src/db/`, `server/src/db/migrations/001_core.sql`, an anonymized fixture matching current `data/db.json`, and a preflight/reconciliation reporter.

Core schema includes settings/import reports, projects, canvases with `version`, components, immutable revisions/files, jobs, design systems, libraries/memberships, skills, nullable-project threads/messages, assets/fonts, asset references, tombstones, and quarantine rows.

Use `foreign_keys=ON`, WAL, busy timeout, transactions, and deferred insertion where needed.

#### Legacy mapping

| Legacy field | SQL/import policy |
|---|---|
| `meta`, `user` | Preserve under settings/local-user rows, including unsupported fields in `legacy_extra_json`. |
| `projects` | Preserve IDs, names, descriptions, timestamps. |
| `components` | Insert with selected revision temporarily null; uniqueness is `(project_id, generated_name)`. Deterministically suffix same-project collisions and report them. |
| `revisions[].files/code` | Insert immutable revision/files first. Preserve legacy status in provenance; mark source-only rows `imported_unbuilt`. |
| component `files/code` | Compare with selected revision. If identical, discard duplicate mutable copy. If different, create a deterministic synthetic imported revision and select it. |
| `selectedRevisionId` | Apply only after revision insertion; missing targets are quarantined and reported rather than aborting unrelated import. |
| Google Font imports | Strip from normalized imported source, record original hashes, and retain the untouched JSON archive as provenance. |
| `jobs` | Preserve request/status/diagnostics where valid; orphan references go to quarantine. |
| canvas `shapes/camera` | Preserve losslessly as `legacy-v0` document plus version; Phase 2 converts it to tldraw. |
| `designSystems` | Preserve tokens, markdown, theme, prompt, and font metadata. |
| design-system/root `fonts` | Import resolvable local files as assets/fonts; unresolved entries remain disabled metadata and appear in the report. |
| `libraries.componentIds` | Create membership using each component’s exact selected revision. Missing components are quarantined. |
| `skills` | Preserve text and metadata; never execute imported content. |
| `chatThreads` | Import without arbitrary project assignment using nullable `project_id` and `scope=legacy_unscoped`. Phase 3 provides assign/archive UI. |
| `chatMessages` | Preserve valid thread relationships; quarantine orphan messages. |
| `images` | Map to assets with legacy provenance. Missing blobs become tombstoned metadata, not broken live URLs. |
| unsupported fields | Preserve in `legacy_extra_json` and enumerate in the reconciliation report. |

Import protocol:

1. Parse and preflight without modifying SQLite.
2. Emit counts, checksums, collisions, orphans, unresolved blobs, and transformations.
3. Import in one transaction and record the source checksum.
4. Verify row/file hashes.
5. Rename JSON only after commit; never overwrite an existing legacy file:
   `db.json.legacy.<checksum-prefix>`.
6. If a crash occurs after commit but before rename, rerun detects the checksum and completes the rename.
7. Corrupt JSON, conflicting prior checksums, and partial imports leave the DB unchanged.
8. Repeated import of the same checksum is a no-op.

Copy—not move—older data found beside source/bundled resources into Application Support only when the destination is uninitialized; record source/checksum and never write back to bundled resources.

### Step 0D: Retention and backups

- `DELETE /assets/:id` tombstones the asset and hides it from normal selection.
- Historical revisions, contexts, screenshots, fonts, imports, and exports retain references and content access.
- Garbage collection removes a blob only when no live or historical reference exists, retention has elapsed, and a verified backup exists.
- Add startup cleanup for multipart files, stale staging directories, and abandoned subprocess metadata.

### Acceptance commands

```bash
npm run verify:phase0
npm run test:integration -- legacy-ui-crud
npm run test:integration -- json-import-current-fixture
npm run test:integration -- json-import-recovery
npm run test:security
npm run test:e2e:prod -- legacy-crud
npm run backup:create -- --label phase0-gate
npm run backup:verify -- --latest
npm run desktop:smoke:clean
```

`verify:phase0` must run lint, typecheck, unit tests, production build, route conformance, SQLite concurrency, corrupt/rerun/partial-import cases, Host/DNS-rebinding/session-expiry tests, and restoration testing.

---

## 4. Phase 1 — Durable candidates and runnable React previews

### Deliverables

Add migration `002_runtime.sql`:

- `revision_candidates`
- `candidate_files`
- `builds(candidate_id, revision_id NULL, …)`
- `artifact_publications`
- `screenshots`

Add:

- `server/src/build/`
- `server/src/preview/`
- `server/src/diagnostics/`
- bounded build-worker implementation;
- React/Vite client under `web/src/`;
- preview frame, viewport, diagnostics, and screenshot UI.

Retire `web/app.js` only after React CRUD parity and production E2E pass.

### Candidate/build protocol

1. Transactionally create candidate, candidate files, and queued build.
2. Validate paths/imports/sizes and build in an isolated bounded subprocess.
3. On failure, persist candidate files and diagnostics; create no revision.
4. On success:
   - stage artifact;
   - write DB publication intent;
   - rename stage to immutable final path;
   - in one transaction create revision/files, attach build, mark candidate promoted, and select only if its expected base revision still matches.
5. A stale concurrent candidate may become an unselected revision but may not overwrite a newer selection.

Crash reconciliation handles every state:

- stage only → remove/retry;
- DB intent plus stage → rename and finalize;
- DB intent plus final artifact → finalize DB;
- intent with neither → rebuild from candidate files;
- committed plus stale stage → delete stage.

Imported `imported_unbuilt` revisions build lazily on preview/export or through `npm run revisions:backfill`; failures retain source and diagnostics without changing selection.

Use sandboxed iframes without `allow-same-origin`, restrictive `connect-src 'none'`, and a validated `postMessage` bridge.

Build/run streams use authenticated `fetch()` parsing SSE records, send `Last-Event-ID`, deduplicate event IDs, and reconnect after token refresh.

### Acceptance commands

```bash
npm run verify:phase1
npm run test:integration -- candidate-crash-matrix
npm run test:integration -- stream-auth-reconnect
npm run test:e2e:prod -- runnable-preview
npm run test:e2e:prod -- invalid-source-diagnostics
MYPATH_NETWORK_DISABLED=1 npm run test:e2e:prod -- historical-rebuild
npm run desktop:smoke:clean
```

---

## 5. Phase 2 — tldraw canvas, assets, reuse selection, and immutable context

### Deliverables

Add migration `003_canvas_context.sql`:

- tldraw snapshots/context snapshots/context references;
- asset extraction/provenance/reference tables;
- `design_system_versions` with version-1 backfill;
- `project_design_systems`, `project_libraries`, `project_skills`.

Add:

- `web/src/canvas/` with design-frame and asset shapes;
- image/text/primitives/arrows/freehand/groups;
- resize, reorder, multi-select, grouping, keyboard tools, undo/redo;
- validated image/document/font ingestion;
- mention index and context pills;
- `ContextEnvelopeV1` containing exact shape, component/revision, asset, design-system/version, library, skill, sketch, and canvas-version references.

Multipart ingestion must sniff content, limit total decompressed/input size, clean temporary files after aborts, sanitize active formats, and use opaque content-addressed storage.

### Canvas concurrency

- Save normal canvas edits with compare-and-swap:
  `UPDATE canvases … WHERE id=? AND version=?`.
- Store job frame insertions in `canvas_frame_publications` with deterministic IDs such as `frame:<logical-job-id>`.
- A materializer reloads the latest snapshot, inserts the record only if absent, and retries bounded CAS conflicts.
- Job completion is acknowledged only after publication is materialized; startup resumes pending publications.
- Never replace an entire stale snapshot without CAS.

### Acceptance commands

```bash
npm run verify:phase2
npm run test:integration -- legacy-canvas-conversion
npm run test:integration -- canvas-cas-merge
npm run test:integration -- asset-retention-gc
npm run test:e2e:prod -- canvas-tools
npm run test:e2e:prod -- immutable-context
npm run test:e2e:prod -- fifty-frames
```

---

## 6. Phase 3 — Project chat and parallel jobs

### Deliverables

Add migration `004_runs_jobs.sql`:

- `thread_runs`
- stable logical `jobs`
- separate `job_attempts`
- `job_events`
- provider configuration without secrets
- unique logical publication key per job

Add provider registry, deterministic fixture provider, Ollama adapter, optional compatible remote adapters, prompt planner, bounded queue, event log, cancellation, restart recovery, and chat UI.

Job identity rules:

- one `job` is one logical deliverable;
- each retry creates `job_attempt N+1` under the same job;
- only one publication exists for the logical job;
- retry reuses the immutable request/context snapshot.

On restart:

- queued attempts are re-enqueued;
- running/streaming/building attempts become `failed/server_restarted`;
- they never silently rerun;
- user retry creates a new attempt.

Provider/build timeouts propagate aborts and terminate subprocess groups. Independent jobs run concurrently; dependent thread work queues behind its predecessor.

Sensitive run events use authenticated fetch streaming and persisted event IDs.

### Acceptance commands

```bash
npm run verify:phase3
npm run test:integration -- job-restart-policy
npm run test:integration -- cancel-kills-provider-and-build
npm run test:integration -- parallel-canvas-publication
npm run test:e2e:prod -- three-screen-run
npm run test:e2e:prod -- cancel-retry-reload
MYPATH_PROVIDER=ollama npm run test:e2e:prod -- ollama-run
```

The deterministic provider must create three independent runnable frames without duplicate revisions or lost canvas records.

---

## 7. Phase 4 — Supported-subset visual editing, revisions, and variants

### Deliverables

Add editor/source-map modules, edit-session and variant tables, layer tree, inspector, revision compare/checkout/restore, and variant UI.

Deterministic editing is explicitly limited to:

- intrinsic JSX elements;
- literal text, class, style, and approved attributes;
- uniquely traceable static nodes.

Mapping rules:

- persistent source IDs identify source nodes;
- runtime occurrence IDs distinguish rendered instances;
- repeated `.map()` nodes, spread props, ambiguous conditionals, fragments, and opaque custom-component internals are read-only unless reconciled;
- duplicate allocates fresh source IDs;
- every operation reparses source instead of trusting stale ranges;
- variants inherit IDs;
- regeneration uses structural matching, with ambiguity producing `422 reconciliation_required`.

`Cancel` discards the edit session. `Done` builds one candidate and creates exactly one revision. Restore creates a child revision rather than mutating history.

### Acceptance commands

```bash
npm run verify:phase4
npm run test:integration -- supported-jsx-mapping
npm run test:integration -- edit-transaction
npm run test:e2e:prod -- visual-edit
npm run test:e2e:prod -- revision-restore
npm run test:e2e:prod -- parallel-variants
```

---

## 8. Phase 5 — Operational design systems, libraries, skills, and fonts

### Deliverables

Add:

- versioned token/`DESIGN.md` compiler;
- local `@font-face` generation;
- library browsing, exact-revision reuse, drag-to-canvas, and copy provenance;
- `/` composer menu for selecting skills as context pills;
- safe text-only skill package import;
- reviewed URL-theme extraction UI and fetcher.

URL theme extraction must require explicit review and implement HTTPS-only policy, private/loopback/link-local blocking, DNS resolution and re-resolution, redirect revalidation, response/decompression limits, timeouts, MIME checks, and no ambient credentials.

Library drag-to-canvas inserts the exact completed revision, never “latest.” Selected systems, libraries, skills, and fonts enter context snapshots, generation, preview, variants, and export.

### Acceptance commands

```bash
npm run verify:phase5
npm run test:security -- theme-url-ssrf
npm run test:integration -- exact-library-revision
npm run test:integration -- skill-import-boundary
npm run test:e2e:prod -- library-drag-to-canvas
npm run test:e2e:prod -- slash-skill-selection
MYPATH_NETWORK_DISABLED=1 npm run test:e2e:prod -- offline-fonts
```

---

## 9. Phase 6 — Reproducible export, IDE workflow, and external agents

### Deliverables

Add runnable zip generation, export manifests, Tauri directory-picker commands, export-directory capability handling, known-IDE launch commands, and external-agent grants/sessions/submission review.

Because the web UI cannot safely submit arbitrary filesystem paths:

1. React invokes a Tauri directory-picker command.
2. Rust canonicalizes the user-approved destination and issues a short-lived destination grant to the backend over the instance-authenticated channel.
3. The web API submits only that grant.
4. Rust launches only configured IDE executables without shell interpolation.
5. Return `{ exportedPath, launchStatus: "launched"|"unavailable"|"failed" }`; export success is retained even when no IDE exists.
6. Browser-only mode supports zip download, not arbitrary directory export.

External agents use scoped bearer grants only for `/api/v1/external-agent/**`. Accept/reject endpoints require the user desktop session and reject agent bearer tokens. Submissions build candidates and create no revision until user acceptance.

### Acceptance commands

```bash
npm run verify:phase6
npm run test:integration -- export-path-grant
npm run test:integration -- external-agent-auth-separation
npm run test:e2e:prod -- clean-export-build
npm run test:e2e:prod -- ide-unavailable-after-export
npm run test:e2e:prod -- agent-submit-accept-reject
npm run desktop:smoke:clean
```

---

## 10. Phase 7 — Web capture, semantic conversion, search, and Figma

### Deliverables

1. **Full-page import**
   - `POST /api/v1/projects/:id/imports/web` creates a fetch/import job.
   - Store sanitized HTML, approved local assets, provenance, headers, final URL, diagnostics, and rights warning.
   - `POST /api/v1/imports/:id/convert` creates a semantic page-to-design job referencing the immutable import artifact.

2. **Surgical capture**
   - Implement `extensions/web-capture/`.
   - A user creates a one-time capture ticket in MyPath.
   - The extension submits a bounded selected DOM subtree, computed-style allowlist, screenshot, and approved asset references.
   - Tickets are origin-scoped, single-use, short-lived, and do not enable general CORS.

3. **Search**
   - Explicit opt-in search provider and immutable result/fetched-context records.
   - Treat fetched text as untrusted reference content, never system/tool instructions.

4. **Figma**
   - Define `FigmaExchangeV1` for frames, hierarchy, text, fills, strokes, effects, assets, typography, and auto-layout.
   - Implement `extensions/figma-plugin/` import/export through that format.
   - Fixture tests cover Figma → MyPath and MyPath revision → Figma exchange output; live OAuth is not required for deterministic acceptance.

All fetch paths reuse the Phase 5 SSRF policy and additionally enforce protocol allowlists, redirect limits, DNS revalidation, and decompression bounds.

### Acceptance commands

```bash
npm run verify:phase7
npm run test:security -- web-import-ssrf-sanitize
npm run test:integration -- semantic-import-job
npm run test:integration -- capture-ticket
npm run test:integration -- figma-roundtrip-fixtures
npm run test:e2e:prod -- web-import-convert
npm run test:e2e:prod -- surgical-capture
```

---

## 11. Final release gate

Run sequentially:

```bash
npm ci
npm run verify:all
MYPATH_NETWORK_DISABLED=1 npm run test:e2e:prod -- core-offline-loop
npm run desktop:build:universal
npm run desktop:smoke:clean
npm run backup:create -- --label release-candidate
npm run backup:verify -- --latest
```

The final production test must prove:

- project chat creates parallel jobs;
- exact immutable context is recorded;
- candidates build into interactive revisions;
- concurrent jobs merge frames without loss;
- restart preserves jobs, diagnostics, artifacts, canvas, and context;
- visual edits, variants, reuse, export, and agent review work;
- the signed packaged app uses Application Support;
- no global Node or fixed port is assumed;
- baseline core behavior works with networking disabled;
- recovery succeeds when terminated at every artifact-publication state.