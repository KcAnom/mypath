# MyPath → MagicPath Functional Parity Audit

**Audit date:** 2026-07-29
**Target:** `/Users/kc/mypath`
**Reference:** MagicPath documentation snapshot captured 2026-07-29 in `magicpath-operator`

## Executive verdict

MyPath is a working local workspace skeleton, but not yet a functional MagicPath equivalent.

It currently delivers project persistence, a basic pan/zoom canvas, component/source revisions, and CRUD stores for design systems, skills, libraries, and chat. The defining MagicPath 2.0 loop is still absent:

> project-level contextual chat → parallel designer jobs → runnable React designs → visual editing/revisions/variants → reuse → export/integration

Across 27 audited capability groups:

- **2 implemented**
- **9 partial**
- **12 missing**
- **4 deliberately excluded by the current local-solo scope**

The most important issue is not the number of missing screens. The runtime architecture cannot yet support MagicPath behavior: generation is a static template, canvas frames show source text instead of an executable design, chat is disconnected from projects/canvas/generation, and the stored design systems/libraries/skills do not influence output.

---

# Part 1 — Functional gaps

## Capability matrix

| MagicPath capability | MyPath status | Current evidence | Gap to close |
|---|---|---|---|
| Projects and local persistence | **Implemented** | Project CRUD and canvas initialization exist in `server/index.js:110-176`; JSON entities are seeded in `server/store.js:24-53`. | Persistence must become concurrency-safe before parallel jobs are added. |
| Infinite project canvas | **Partial** | `web/app.js:211-330` supports pan, zoom, selection, and dragging. | It is a custom component-only board. No text, primitives, sketches, images, resize, grouping, multi-select, undo/redo, layers, or agents. |
| Interactive React-backed designs | **Missing** | Canvas shapes display the first 900 characters of source (`web/app.js:246-261`). Preview renders escaped code in `<pre>` (`server/index.js:398-415`). | Build and run generated React inside isolated iframe previews. |
| AI design generation | **Partial** | Prompt creates files, a revision, and a shape. `server/generate.js` is explicitly a fixed local template. | Add model providers, prompt/context assembly, compile validation, retries, and diagnostics. |
| Multi-screen parallel designer agents | **Missing** | One synchronous `/generate` call creates one component. | Parse named deliverables into bounded parallel jobs with independent status and failure handling. |
| Project-level chat | **Partial** | Threads/messages persist, but are global and the assistant response is hard-coded (`server/index.js:529-570`). | Scope threads to projects and connect them to model execution, canvas context, jobs, and outputs. |
| Canvas selection and `@` mention context | **Missing** | Chat accepts only a text string. | Add selection pills, immutable revision references, a project mention index, uploads, and active reuse context. |
| Queueing, streaming, cancel/retry, new-thread execution | **Missing** | Event names exist only as disconnected constants in `packages/canvas/src/events.ts`. | Implement job/thread state machines, SSE or WebSocket streaming, cancellation, retry, and dependent/independent execution. |
| Images, documents, and fonts | **Missing** | Arrays and route constants exist, but no server handlers or UI. | Add validated local ingestion, storage, serving, metadata, and context attachment. |
| Sketchpad and drawing tools | **Missing** | No model or UI for sketch shapes. | Add drawing primitives and selected-sketch context. |
| Visual layer editing | **Missing** | Current editing replaces raw source in a textarea (`web/app.js:377-392`). | Add iframe-to-source element mapping, layer tree, property inspector, deterministic patches, and AI reconciliation. |
| Revision history and rollback | **Partial** | Revisions are created and source can be loaded. | Loading does not check out the selected revision. Add compare, checkout, restore-as-new, build status, and immutable provenance. |
| Variants | **Missing** | Variation routes are declared but not implemented. | Add parent-linked, parallel variants by layout/style/color/copy/device/hypothesis. |
| Design systems | **Partial** | CRUD supports tokens, prompt, and Markdown (`server/index.js:419-480`). | Systems are not selectable in chat/canvas and never affect generation, editing, variants, preview, or export. CSS/web import and theme extraction are absent. |
| Component libraries | **Partial** | Libraries can be created and store `componentIds`. | Add membership, activation, browsing, drag/copy to project, and explicit `@` reuse. |
| Skills | **Partial** | Text skill CRUD exists. | Add `/` selection, activation, built-ins, safe text-only package import, validation, and prompt injection into jobs. |
| Web search | **Missing** | No provider or composer integration. | Add explicit opt-in search/fetch with provenance and untrusted-content boundaries. |
| External agent / repository bridge | **Missing** | Contracts are listed in `packages/generation/src/api.ts`, but no endpoints run. | Add scoped project/design context APIs, forge-boundary submissions, job polling, and reviewable diffs. |
| React/TypeScript/Tailwind export | **Partial** | Some forge files are written under `data/forge/<componentId>/`. | Output lacks a complete runnable project, dependency manifest, zip route, Open in IDE, validation, and assets. |
| Web capture / webpage import | **Missing** | No implementation. | Add sanitized URL/HTML ingestion and page/element-to-component conversion. |
| Figma import/export | **Missing** | Explicitly excluded in the README. | Optional adapter after the core editor/export model is stable. Exact Figma parity requires OAuth/plugin work. |
| Keyboard editing workflow | **Partial** | Mouse canvas controls and Enter-to-send exist. | Add selection, drawing, duplicate, grouping, movement, undo/redo, auto-layout, and layer navigation shortcuts. |
| Multiplayer/presence | **Deliberate exclusion** | README defines local-solo mode and omits Liveblocks. | Requires a scope change and collaboration backend. Not needed for local core parity. |
| Invitations, roles, public links/comments | **Deliberate exclusion** | Accounts and multi-tenancy are intentionally removed. | Requires identity, authorization, sharing, and hosted access. |
| Billing, credits, plans, org/admin | **Deliberate exclusion** | Explicitly removed. | Do not rebuild unless MyPath becomes a SaaS product. |
| Team systems/libraries/skills | **Deliberate exclusion** | Local personal equivalents are the intended scope. | Keep personal/local reuse; add teams only with multi-user scope. |

## The seven critical blockers

### P0. No real generation intelligence
`server/generate.js` always emits the same card-shaped template. Prompts change strings, not architecture, behavior, or design quality.

### P0. No executable prototype runtime
A MagicPath design is interactive React. MyPath currently shows source text. Until generated TSX is compiled and rendered, visual review, responsive behavior, visual editing, screenshots, and meaningful export cannot work.

### P0. Chat, canvas, generation, and reuse are disconnected
The MagicPath 2.0 operating model is one project-level conversation using selected canvas objects, uploads, mentions, design systems, libraries, and skills. MyPath stores each concept separately.

### P0. The loopback API is unsafe for agent/import work
- `Access-Control-Allow-Origin: *` is returned for mutating endpoints.
- There is no local session token.
- Request bodies have no size limit.
- Forge file keys are joined without rejecting absolute paths or `..` traversal.

These must be fixed before accepting model, web, upload, or external-agent input.

### P1. JSON persistence cannot support parallel agents
Every mutation reads and rewrites the whole JSON database without locking or transactions (`server/store.js:66-75`). Concurrent jobs can overwrite each other.

### P1. There is no layer/source document model
A rectangle containing a source string cannot support deterministic visual edits, layer navigation, compatible multi-selection, layout tools, or safe structural reconciliation.

### P1. API contracts and runtime have drifted apart
`packages/shared/src/routes.ts` declares 77 routes; dozens are not implemented. The `packages/*` TypeScript modules are not imported by the runtime. They are scaffolding, not functionality.

## Important technical debt found during the audit

- No tests, test runner, lint script, typecheck script, or root build validation.
- Generated TSX is never compiled or typechecked.
- Project/component deletion leaves revision/job/forge artifacts behind.
- README says offline, but the shell and generated CSS fetch Google Fonts.
- Three desktop paths exist (Tauri, Swift, Electron), increasing drift. Tauri is the supported root path; Electron does not start the server.
- Packaged data is resolved under the project/bundle tree rather than a durable OS application-data directory.

---

# Part 2 — New implementations required

## Architecture decision: keep, replace, connect

### Keep and harden
- Local-first product model
- Project/component/revision concepts
- Forge file boundary
- Tauri desktop shell
- Design-system, library, skill, and thread concepts

### Replace
- Whole-file JSON store → **SQLite with WAL and migrations**
- Hand-written source-text canvas → **React/Vite app with tldraw and runnable design frames**
- Static template generator → **provider registry plus asynchronous build jobs**
- Escaped source preview → **sandboxed compiled iframe runtime**

### Connect or remove
- Make `packages/shared` the authoritative contract.
- Wire `packages/canvas`, `generation`, `chat-agents`, `design-systems`, `libraries`, `skills`, and `assets-media` into the runtime.
- Delete route/service declarations that remain intentionally unsupported.

## Phase 0 — Safety, contracts, and persistence

**Implement**
- Local session token and strict origin checks; remove wildcard CORS.
- Request body limits and runtime schemas for every mutation.
- Forge allowlist: only `src/App.tsx`, `src/index.css`, `src/components/generated/**`, and `assets/**`; reject traversal, absolute paths, and symlink escape.
- SQLite/WAL repositories, migrations, backups, transactional job/component/revision/canvas writes.
- Durable app data under the OS application-support directory.
- Root test, lint, typecheck, and build scripts.
- Route conformance tests: every declared endpoint must be implemented or explicitly unsupported.

**Gate**
- Cross-origin and tokenless mutations fail.
- Traversal and oversized payload tests pass.
- Parallel writes do not lose records.
- Restart and interrupted-write recovery pass.

## Phase 1 — Runnable design runtime

**Implement**
- Migrate `web/app.js` into `web/src/` as a Vite/React application.
- Local React 19 + TypeScript + Tailwind build service.
- Complete forge template: entry point, package metadata, CSS, assets, dependencies, and build manifest.
- Sandboxed iframe preview with viewport controls, loading/error states, console/build diagnostics, and screenshot support.
- Revision promotion only after a successful build.

**New server modules**
- `server/build/`
- `server/preview/`
- `server/diagnostics/`

**Gate**
- Generated controls are interactive inside the canvas.
- Invalid TSX produces diagnostics and is not selected.
- Valid designs rebuild after app restart without a network connection.

## Phase 2 — Real canvas and context primitives

**Implement**
- tldraw-backed project canvas.
- Shape types: runnable design frame, image, text, rectangle, ellipse, line, arrow, freehand sketch, group.
- Resize, reorder, multi-select, grouping, undo/redo, keyboard tools, persisted camera/document.
- Local asset/font/document ingestion with validation and safe serving.
- Versioned context envelope containing selected shape/revision IDs, `@` mentions, uploads, active design system, active libraries, and selected skills.
- Searchable project mention index and composer selection pills.

**Gate**
- Mixed selections survive reload and resolve to exact revisions.
- Sketch/image/mention context reaches the recorded job request.
- At least 50 runnable frames remain responsive.

## Phase 3 — Project chat and parallel designer jobs

**Implement**
- Project-scoped threads and messages.
- Provider registry: Ollama/local first; optional user-configured OpenAI/Anthropic-compatible providers.
- Prompt planner that converts named screens, states, edits, or variants into individual jobs.
- Job state machine: queued → running/streaming → building → completed/failed/cancelled.
- Bounded parallel execution, SSE/WebSocket progress, retry, cancel, and independent failure handling.
- Dependent follow-ups queue behind a busy thread; independent work can run in a new thread.
- Atomic completion: successful build creates component, revision, job result, and canvas frame together.

**Suggested data additions**
- `jobs`, `job_events`, `thread_runs`, `context_snapshots`, `context_refs`, `builds`, `provider_configs`

**Gate**
- “Create desktop, mobile, and empty-state screens” produces three concurrent jobs and three runnable frames.
- One failed sibling does not roll back successful work.
- Cancel/retry/reload never duplicates revisions or canvas shapes.

## Phase 4 — Visual edits, true revisions, and variants

**Implement**
- Stable preview element IDs and iframe selection bridge.
- Layer tree plus inspector for content, typography, color, border, size, layout, and position.
- Edit transaction: **Cancel** changes nothing; **Done** creates exactly one revision.
- Deterministic AST/CSS patches for safe edits.
- AI reconciliation for computed, imported, state-driven, or structurally ambiguous edits.
- Revision checkout, compare, restore-as-new, and immutable parent links.
- Parent-linked variants with layout/style/color/copy/audience/device dimensions.

**New modules**
- `packages/editor/`
- `server/revisions/`
- `server/source-map/`

**Gate**
- Targeted text/color edit changes only the selected layer.
- Cancel leaves source/history unchanged.
- Historical checkout renders the exact old build.
- Four variants can run concurrently and remain traceable to their parent.

## Phase 5 — Make design systems, libraries, skills, and fonts operational

**Implement**
- Apply selected tokens and `DESIGN.md` to generation, editing, variants, preview, and export.
- CSS/token import, theme extraction, reviewed web extraction, and light/dark modes.
- Bundle local custom fonts; remove implicit Google Fonts requests.
- Library membership, activation, drag-to-canvas, copy-to-project, and `@` reuse.
- `/` skill selection, optional description-based activation, built-ins, and safe text-only package import under 5 MB.

**Gate**
- Multi-screen generation reuses the named component rather than approximating it.
- Generated and exported output uses selected semantic tokens and bundled fonts offline.
- Imported skills cannot execute code or escape storage.

## Phase 6 — Export and local external-agent workflow

**Implement**
- Download a selected completed revision as a runnable zip.
- Include React, TypeScript, Tailwind, assets, tokens, dependency manifest/lock strategy, and README.
- Safe **Open in IDE** into a new explicit directory.
- Local external-agent API for project discovery, approved context reads, forge-boundary edit sessions, revision submissions, job polling, and diff review.
- Scope grants per project/path; never expose secrets automatically.

**Gate**
- Exported zip installs, builds, and runs in a clean temporary directory.
- IDE export does not modify the MyPath workspace.
- External agents cannot read or write outside granted project/forge boundaries.

## Phase 7 — Optional imports and non-core parity

**Implement after core loop is stable**
- Full-page web-to-design.
- Surgical element capture through a local browser extension/helper.
- Figma import/export adapter or plugin.
- Explicit provenance, sanitization, content-rights warnings, and untrusted-content handling.

**Gate**
- Imported pages cannot execute scripts in MyPath or inject instructions into agent control context.
- Imported assets are local, reviewable, and exportable.

## Deliberate exclusions unless product scope changes

Do not block local core parity on:

- Multiplayer/presence
- Accounts and hosted authentication
- Invitations, Viewer/Editor roles, comments, and public share links
- Teams, organizations, billing, credits, plans, and admin
- Hosted analytics, community gallery, cloud registry, and hosted support
- Hosted always-on agent execution

If “same functionality” means exact SaaS parity rather than local-solo parity, these need a separate identity/collaboration/cloud architecture program.

---

# Recommended build order

1. **Safety + SQLite + tests**
2. **Runnable React preview/build pipeline**
3. **React/tldraw canvas + assets + context envelope**
4. **Project chat + provider registry + parallel jobs**
5. **Visual editing + true revision control + variants**
6. **Operational design systems/libraries/skills/fonts**
7. **Zip/IDE/external-agent export**
8. **Web and Figma adapters**

Do not begin with Figma, multiplayer, or visual polish. Until phases 0–4 are complete, MyPath cannot deliver the core MagicPath workflow regardless of how closely its screens resemble MagicPath.

## First implementation slice

The first shippable milestone should be:

> From a project chat, ask for two named screens; MyPath runs two local model jobs in parallel, compiles both to runnable React, and places both interactive frames on a persisted tldraw canvas with build diagnostics and revision history.

That slice proves the architecture and unlocks the later editor, variants, reuse, and export work.
