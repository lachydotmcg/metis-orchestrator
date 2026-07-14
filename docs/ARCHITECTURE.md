# Architecture

A contributor-facing map of how Metis Orchestrator is put together. Written
from the actual code - every path and function name below is real and
grep-able. If something here goes stale, trust the code and fix this file.

## The Metis stack

Metis is four separate pieces. This repo is only the fourth one.

- **Benchmark** - a separate research-grade local-model benchmark repo
  (`OneDrive\Documents\Metis`, outside this repo) that produces a leaderboard
  payload measuring local models against real tasks.
- **Policy** - `metis-policy`, a sibling CLI repo (not this repo). Given a
  prompt, it returns a `RouteDecision` (which provider/model to use and why).
  It's expected to live as a sibling directory during local dev - see
  `policyCliCandidates()`/`policyProfileCandidates()` (`main.ts:2808-2830`),
  which look for `../metis-policy/dist/src/cli.js` and `../metis-policy/profile.json`
  relative to `process.cwd()`/`app.getAppPath()` (overridable via
  `METIS_POLICY_CLI`/`METIS_POLICY_PROFILE`). Its profile is meant to be
  imported from a Benchmark leaderboard payload - see the literal status
  string in `getPolicyStatus()`: `"No policy profile was found. Import a
  Metis leaderboard payload first."` When the CLI or profile isn't found,
  `decidePolicy()` (`main.ts:2864`) falls back to a canned `sampleDecision`
  (`src/shared/sample-decision.ts`) rather than failing the run.
- **Oracle** - speculative prewarm/draft/serve for pinned local Ollama chat,
  implemented entirely inside this repo (`main.ts`, `preload.cts`,
  `App.tsx`). Fully documented in [`docs/ORACLE.md`](./ORACLE.md) - that
  document is the source of truth for Oracle; this file only places it in
  the stack.
- **Orchestrator** (this repo) - the Electron + React desktop app that ties
  the other three together: runs the chat/build pipeline, calls Policy for
  routing, calls providers (including local Ollama, where Oracle sits), and
  is the only layer with a UI.

## Process model

Standard three-process Electron split, plus a shared types package:

- **Main** - `src/electron/main.ts` (~9,700 lines). Runs in Node with full
  OS access: filesystem, `child_process` (spawns the `metis-policy` CLI,
  dev/preview servers), `safeStorage` (encrypted secrets), and all outbound
  network calls to providers. Owns every IPC handler, the run pipeline, the
  JSON-file stores, and the audit log. Nothing here is reachable from the
  renderer except through the channels `preload.cts` explicitly exposes.
- **Preload** - `src/electron/preload.cts`. The only bridge between the two
  worlds. Every capability the renderer can use is an explicit
  `contextBridge.exposeInMainWorld("metisXxx", { ... })` call wrapping
  `ipcRenderer.invoke`/`.send`/`.on`. There is no direct Node access from the
  renderer: `createWindow()`'s `BrowserWindow` (`main.ts:9448`) sets
  `contextIsolation: true` and `nodeIntegration: false` in its
  `webPreferences` (`main.ts:9459-9463`). A second, separate hidden
  `BrowserWindow` - `verifyPreviewInBrowser()` (`main.ts:4181`) - is spun up
  internally during build verification (loads a generated project's preview
  URL headlessly to check for console errors) and additionally sets
  `sandbox: true`; it's not the app window and has no preload script at all.
- **Renderer** - `src/renderer/ui/App.tsx` (~14,600 lines, one file). React
  18 mounted by `src/renderer/main.tsx` via `ReactDOM.createRoot`, built by
  Vite. Talks to main exclusively through `window.metisXxx` (typed in
  `src/renderer/global.d.ts`). Owns all UI state, including some
  store-backed UI prefs it persists itself via `useAppStoreState`
  (`App.tsx:1439`) - a thin hook over `window.metisStore.get/set`.
- **Shared** - `src/shared/runtime-contracts.ts` (~1,000 lines of `export
  type`/`export interface`) plus `src/shared/policy-contract.ts`,
  `sample-decision.ts`, and `design-seeds.ts`. Every payload that crosses
  the main↔renderer boundary is typed here and imported by both
  `preload.cts` and `App.tsx`, so the IPC contract can't silently drift
  between the two sides.

**Trust boundary**: the renderer is treated as untrusted UI. It can only ask
main to do things via the typed `window.metisXxx` calls; main independently
re-checks flags like `prewarmEnabled` (see `docs/ORACLE.md`) rather than
trusting the renderer to have gated the call correctly. Filesystem writes
and other side-effecting scopes go through `gatePermission()`
(`main.ts:1901`), not raw IPC trust.

## Build + run scripts

From `package.json`:

| Script | What it does |
| --- | --- |
| `npm run dev` | `concurrently`: starts Vite on `127.0.0.1:5177`, waits for it, runs `build:electron`, then launches `electron .` with `VITE_DEV_SERVER_URL` pointed at the Vite dev server. |
| `npm run build:electron` | `tsc -p tsconfig.electron.json` - compiles `src/electron/**/*.{ts,cts}` and `src/shared/**/*.ts` to `dist-electron/` (`outDir`), `rootDir: src`, target `ES2022`/`NodeNext`. |
| `npm run typecheck` | Type-checks the renderer (root `tsconfig.json`, implicit) and the electron/shared tree (`tsconfig.electron.json`), both `--noEmit`. |
| `npm run build` | `typecheck` → `vite build` (renderer to `dist/`, per `vite.config.ts`) → `build:electron`. This is the full production build. |
| `npm start` | `build` then `electron .` - a non-dev production-mode launch. |
| `npm run preview` | `vite preview` on port 4177 (renderer only, no Electron shell). |
| `npm run pack` | `electron-builder --dir` - unpacked app, no installer. |
| `npm run dist` | `build` then `electron-builder` - the real installer build. |

`package.json`'s `"main"` is `dist-electron/electron/main.js`, which is why
`build:electron` must run before `electron .`/`electron-builder` can find an
entry point. `electron-builder.yml` packages `dist-electron/**`, `dist/**`,
and `package.json` into `release/`, targets NSIS on Windows / dmg on macOS /
AppImage on Linux, and publishes to the `lachydotmcg/metis-orchestrator`
GitHub repo.

## The run pipeline

Every session run enters through `runSessionTracked()` (`main.ts:7217`,
just a live-run counter wrapper for the tray icon) → `runSession()`
(`main.ts:7228`). `runSession` is one long function that branches into three
shapes depending on the input:

1. **Pinned-direct chat** - `input.modelOverride` is set. Per the comment at
   `main.ts:7335-7339`: *"if the model is not on Auto Router, there should be
   NO orchestration."* This skips the build-pipeline gate entirely (the `if`
   at `main.ts:7340` requires `!input.modelOverride` unless an explicit
   `/orchestration` command forces it) and falls through to the chat branch
   starting around `main.ts:7654`. This is also the only path Oracle can
   serve into - see `docs/ORACLE.md`.
2. **Chat fast-lane / normal chat** - Auto Router path when
   `shouldRunBuildPipeline()` (`main.ts:5407`) says no. Within this branch,
   `isFastLaneEligible()` (`main.ts:5529`) further decides whether a short,
   plain `general_chat` turn can skip the project-snapshot walk and
   knowledge-bank retrieval (`fastLane` flag, `main.ts:7687`) - a latency
   optimization, not a different code path. The assembled prompt is built
   by `sessionProviderPrompt(...)` and sent via `invokeProvider()`
   (`main.ts:938`).
3. **Build pipeline** - entered when `shouldRunBuildPipeline()`
   (`main.ts:5407`) returns true (or `/orchestration ...` forces it, or an
   edit intent hits an already-populated project folder). Inside this
   branch:
   - An **edit** against an existing project (`editMode`, `main.ts:7406`)
     runs a single non-destructive edit stage rather than a fresh design.
   - Otherwise it's a **fresh build**, which either goes through
     `runOrchestratedStages()` (`main.ts:6481` - the default
     Plan → Front end → Functional staged pipeline; background/history in
     `docs/ORCHESTRATION.md`) or, if the opt-in `fanoutEnabled` store key is
     on (`shouldAttemptFanout()`, `main.ts:5921`), the N-agent fan-out
     engine (`runFanoutPipeline`, agents named from `FANOUT_AGENT_NAMES`:
     Nyx, Talos, Echo, Atlas, Juno, `main.ts:5911`) that decomposes the
     prompt into file-territory sub-tasks via `planFanoutTasks()`
     (`main.ts:5934`) and merges results through a file-claim ledger. A
     fan-out failure anywhere falls back to the untouched single pipeline -
     it can never make a build worse.
   - Every stage call goes through `callStageWithFallback()`
     (`main.ts:5688`), which expands each chain entry across every access
     route of its model, rotates through pooled provider accounts, and
     skips providers currently cooling down from a 429 ("Never Run Dry").
   - Generated files are pulled out of stage output by
     `extractProjectFiles()` (`main.ts:5546`, falling back to
     `runExtractionRecovery` if zero files were found) and written by
     `writeProjectFiles()` (`main.ts:5556`), gated by `gatePermission()`
     for `filesystem.write`.

**Permission modes** (`PermissionMode` in `runtime-contracts.ts:99`:
`"ask" | "edits" | "plan" | "auto" | "bypass"`) are resolved per run by
`resolvePermissionMode()` (`main.ts:1877`) and enforced centrally by
`gatePermission()` (`main.ts:1901`) - every scoped action (mainly
`filesystem.write`) asks this one function whether to proceed, prompt, or
refuse, rather than each call site reimplementing the policy.

**The directive bus** (`sessionDirectives` map, `main.ts:6390`,
`directiveScopeKey()`) lets a running session receive mid-run steering text
- posted via `postSessionDirective()` and picked up between stages by
`takePendingDirectives()` (`main.ts:6463`), which can address a specific
fan-out agent by name (`toAgent`) or broadcast to all of them. This is also
what the Stop button's cancel scope (`directiveScopeKey(projectPath)`) hangs
off - cancelling a run aborts every in-flight controller registered under
that same scope key.

Streaming to the renderer happens via `SessionStreamEvent` (union in
`runtime-contracts.ts:727`) emitted through `emitStream`/`emitTimeline`
helpers and delivered over the `metis-session:stream-event` IPC channel that
`metisSession.runStream` wires up per-call in `preload.cts:52-61`.

## The Metis Gateway

A loopback-only, off-by-default HTTP server (`startGateway()`, `main.ts:10246`)
that exposes an OpenAI-compatible API on `127.0.0.1:<gatewayPort>` (default
`11500`, `GATEWAY_DEFAULT_PORT`) so any OpenAI-client app, script, or tool can
point its base URL at Metis instead of a cloud provider. It's deliberately
narrow: it reuses `invokeProvider()` for the final "call one model, hand back
the text" step, mirroring the chat path's own final call, rather than
touching `runSession` or the build pipeline.

- `GET /v1/models` (`handleGatewayModelsList`) returns `metis-auto` plus
  every installed Ollama tag (`listOllamaModels().installed`).
- `POST /v1/chat/completions` (`handleGatewayChatCompletions`) accepts a
  standard OpenAI chat-completions body. `resolveGatewayRoute()`
  (`main.ts:10058`) decides how to handle `model`: when it's empty,
  `metis-auto`, or `unknown`, it runs the exact same `decidePolicy()` +
  `applySessionRouteOverrides()` + `providerFromRoute()` chain the Auto
  Router chat path uses, on the request's last user message; any other
  string is treated as a pinned model id and resolved via
  `providerFromRoute()` + `resolveOverrideModel()`, the same way a
  composer-pinned override resolves. `stream: true` returns Server-Sent
  Events (`chat.completion.chunk` deltas, via `streamGatewayChatCompletion()`);
  otherwise a single JSON `chat.completion` object is returned.
- Every request must carry `Authorization: Bearer <gatewayToken>`. The token
  is auto-generated on first use and persisted under the `gatewayToken`
  store key (`readOrCreateGatewayToken()`), checked with a constant-time
  `timingSafeEqual` comparison (`gatewayTokenMatches()`) - a missing or
  invalid token gets a `401` before any handler runs.
- Every handler is wrapped to fail soft: a bad request, a downstream
  provider error, or a bind failure resolves to an OpenAI-shaped JSON error
  instead of throwing out of the server. One audit line per request
  (`gateway.request`) records the resolved model id, timing, and
  ok/error - never the prompt or messages content.
- Controlled by the `gatewayEnabled` store flag (default `false`) via
  `setGatewayEnabled()`, wired to the `metis-gateway:get-status` /
  `metis-gateway:set-enabled` IPC handlers and the `metisGateway` bridge;
  toggling it live starts or stops the server without a relaunch.

## Persistence + stores

Everything persisted lives under `app.getPath("userData")/metis-store/`.
Two low-level primitives in `main.ts` do all the work:

- `readStoreValue<T>(key, fallback)` / `writeStoreValue<T>(key, value)`
  (`main.ts:531-544`) - read/write a single JSON file at
  `metis-store/<key>.json` (path built by `storePath()`, `main.ts:524`,
  which validates `key` against `storeKeyPattern` first). This is the
  generic key/value store the `metisStore.get/set` IPC bridge exposes
  directly to the renderer, and that `useAppStoreState` (`App.tsx:1439`)
  wraps for renderer-owned UI state.
- `dataPath(...parts)` (`main.ts:546`) - builds a path under the same
  `metis-store/` root for anything that isn't a single flat JSON value:
  `audit-log.jsonl`, `knowledge/<hash>.json` (per-project embeddings cache),
  `knowledge/conversations.json` (cross-conversation search index),
  `packages/<id>/` (installed registry packages), `generated-projects/`
  (app-managed project output when no folder is selected), and
  `preview-screenshots/`.

Store keys actually read/written in `main.ts` (non-exhaustive list of the
ones that matter):

| Key | Shape | What it holds |
| --- | --- | --- |
| `profile` | `UserProfile` | The local user profile record. |
| `projectWorkspace` | `ProjectWorkspace \| null` | The currently selected/attached project folder. |
| `projectResources` | `ProjectWorkspaceResource[]` | Extra files/folders attached to the workspace beyond the main folder. |
| `conversations` | `ConversationRecord[]` (capped 200) | Chat history, one record per conversation. |
| `sessionRuns` | `SessionRun[]` (capped 100) | Raw run records (separate from conversation turns). |
| `permissions` | `PermissionGrant[]` | Granted permission scopes, consulted by `gatePermission`. |
| `secrets` | `StoredSecrets` | Provider API keys (single "classic" key per provider), `safeStorage`-encrypted where available. |
| `providerAccounts` / `account-secrets` | pooled account config / encrypted values | The multi-account "Never Run Dry" key pools. |
| `registryState` / `installedPackages` | `RegistryState` / `RegistryPackage[]` | Cached + installed community registry packages. |
| `remoteModelCatalog` | `ModelCatalogState` | Cached model catalog from the registry. |
| `pulseFeed` | `PulseFeed` | Cached Community tab changelog/news. |
| `graphPipeline` | `GraphPipelineConfig \| null` | The user's custom orchestration graph, if configured. |
| `knowledgeBankEnabled` | `boolean` (default `true`) | Toggles project knowledge-bank retrieval. |
| `fanoutEnabled` | `boolean` (default `false`) | Opt-in for the N-agent build fan-out engine. |
| `modelDrivenRoutingEnabled` | `boolean` (default `false`) | Opt-in for the local-model build/chat/edit classifier. |
| `prewarmEnabled` | `boolean` (default `false`) | Oracle's master switch - see `docs/ORACLE.md`. |
| `selfVerify` | `"off" \| "local" \| "all"` (default `"local"`) | Which builds get the preview self-verification pass. |
| `routines` / `routinesPaused` | `Routine[]` / `boolean` | Scheduled routines and their global pause flag. |
| `visionModel` | `string` | The Ollama model used for image captioning. |
| `galleryBoards` / `styleCards` | gallery board + style-card records | The Gallery feature's mood-board data. |
| `todoBoard` / `managerModel` | Manager tab board + model choice | The Manager assistant's to-do board and pinned model. |

Renderer-only UI prefs (`permissionMode`, `managerChat`, `graphPhysics`,
`lastSeenPulse`, manager-widget position, etc.) live in the same
`metis-store/<key>.json` files but are read/written exclusively via
`useAppStoreState` in `App.tsx` - main never reads them back for its own
logic, except where they're threaded explicitly into a call's input (e.g.
`permissionMode` travels in on `SessionRunInput.permissionMode`, not read
from the store inside `runSession`).

**Audit log**: every notable action calls `appendAudit(level, kind,
summary, metadata?)` (`main.ts:559`), which appends one JSON line to
`metis-store/audit-log.jsonl`. `listAudit(limit)` (`main.ts:574`) reads the
last N lines back in reverse order for the `metisAudit.list` bridge.

**Knowledge index cache**: `buildOrLoadKnowledgeIndex()` (`main.ts:5152`)
embeds a project's files into `KnowledgeChunk[]` vectors, cached at
`knowledgeCachePath()` (`main.ts:5144`) - `dataPath("knowledge",
"<sha256-of-resolved-root>.json")` - and invalidated by
`knowledgeSourceSignature()` (file size + mtime hash) whenever the
project's files change. `retrieveKnowledgeForPrompt()` (`main.ts:5261`) is
the single entry point every prompt-assembly site calls, honoring the
`knowledgeBankEnabled` toggle and returning `null` (a strict no-op) when
there's nothing to ground on.

## The IPC bridge surface

Every bridge is declared twice - once in `src/electron/preload.cts` (the
runtime `contextBridge.exposeInMainWorld` calls) and once in
`src/renderer/global.d.ts` (the `Window` interface types the renderer
compiles against). The corresponding `ipcMain.handle`/`ipcMain.on`
registrations all live inline inside `app.whenReady().then(...)` in
`main.ts`, starting at `main.ts:9579`.

| `window.metisXxx` | Methods | What it does |
| --- | --- | --- |
| `metisPolicy` | `getSampleDecision`, `getStatus`, `decide` | Calls into the sibling `metis-policy` CLI for routing decisions (`decidePolicy`/`getPolicyStatus`). |
| `metisStore` | `get`, `set` | Generic key/value read-write into `metis-store/<key>.json` - the primitive other domain stores and `useAppStoreState` sit on top of. |
| `metisWindow` | `minimize`, `toggleMaximize`, `close` | Custom frameless-window titlebar controls. |
| `metisShell` | `openExternal`, `openPath` | Opens a URL or local path in the OS default handler. |
| `metisSession` | `run`, `runStream`, `list`, `cancel`, `answerQuestion` | The run pipeline entry points (`runSessionTracked`/`runSession`), past-run listing, cancel, and in-run question answers. |
| `metisBus` | `post`, `list` | The directive bus - mid-run steering messages (`postSessionDirective`/`listSessionDirectives`). |
| `metisConversations` | `list`, `create`, `delete`, `deleteProject`, `rename`, `archive`, `exportMarkdown` | Conversation history CRUD. |
| `metisKnowledge` | `searchConversations` | Semantic search across past conversations (separate from the per-project knowledge index). |
| `metisLab` | `runExperiment` | Runs a Benchmark-style lab experiment. |
| `metisProfile` | `get`, `set` | The `UserProfile` record. |
| `metisProject` | `getWorkspace`, `snapshot`, `selectFolder`, `clearWorkspace`, `listResources`, `addFiles`, `addFolder`, `removeResource` | The active project workspace and its attached resources. |
| `metisFiles` | `read`, `write` | Direct file read/write (in-app file editing). |
| `metisSecrets` | `list`, `set`, `delete` | Provider API key management, `safeStorage`-encrypted where available. |
| `metisPermissions` | `list`, `request`, `revoke`, `respond` | The permission-grant system `gatePermission` reads and writes. |
| `metisAudit` | `list` | Reads `audit-log.jsonl` back. |
| `metisProviders` | `list`, `healthCheck`, `invoke` | Provider status and one-off `invokeProvider` calls outside the run pipeline. |
| `metisRegistry` | `list`, `refresh`, `listInstalled`, `install`, `uninstall` | The community registry (`metis-registry`). |
| `metisMcp` | `probe` | Test-connects to an MCP server definition. |
| `metisCatalog` | `models` | The cached remote model catalog. |
| `metisPulse` | `feed` | The Community tab's changelog/news feed. |
| `metisRoutines` | `list`, `save`, `delete`, `runNow` | Scheduled routine CRUD plus a manual trigger. |
| `metisOllama` | `list`, `pull`, `onPullProgress` | Local Ollama model management. |
| `metisPrewarm` | `warm`, `draft` | Oracle's two speculative calls (`prewarmModel`/`draftModel`) - see `docs/ORACLE.md`. |
| `metisManager` | `chat`, `runAction` | The Manager chat assistant and its action executor (`run_in_project`/`add_todo`/`open_view`). |
| `metisUpdates` | `check` | GitHub-releases update check. |
| `metisGateway` | `getStatus`, `setEnabled` | The Metis Gateway's on/off state (`enabled`, `running`, `port`, `token`) and the live start/stop toggle (`getGatewayStatus`/`setGatewayEnabled`). |
| `metisGallery` | `analyzeBoard`, `analyzeImage`, `cards`, `updateCard`, `deleteCard`, `importUrls`, `importPinterest` | The style Gallery - vision-tagged mood boards. |

## The registry

The community registry is a separate repo,
`github.com/lachydotmcg/metis-registry`, fetched **read-only** over raw
GitHub content. `METIS_REGISTRY_BASE_URL` (`main.ts:481`) points at
`https://raw.githubusercontent.com/lachydotmcg/metis-registry/main`, and
`refreshRegistry()`/`refreshModelCatalog()` pull `index.json`,
`packages/<id>/manifest.json`, `catalog/models.json`, and `featured.json`
from it (overridable per-call via an explicit `sourceUrl` argument, e.g.
for testing against a fork). Results are cached in the `registryState` /
`remoteModelCatalog` / `pulseFeed` stores so the app still has something to
show offline. A hardcoded `registryFallbackPackages` array (`main.ts:484`)
covers the case where the registry has never been reached at all. Installing
a package verifies its SHA-256 before writing anything (`main.ts:2313`
refuses on mismatch) and copies it into `dataPath("packages", id)`;
uninstalling revokes any permission grants that package held.

## Where to add things

**A new provider**
1. Add the key to `ProviderKey` in `src/shared/runtime-contracts.ts:3`.
2. Add its label/default model to `providerInfo` (`main.ts:112`) and, if it
   needs an API key, its env var name(s) to `providerEnvNames`
   (`main.ts:125`).
3. If it speaks the OpenAI chat-completions schema, it likely just needs a
   branch inside `invokeCloudProvider()` (`main.ts:1206`); otherwise add a
   dedicated branch in `invokeProvider()` (`main.ts:938`, which already
   special-cases `ollama`).
4. Wire it into `providerFromRoute()` (`main.ts:2919`) if `metis-policy`
   should be able to select it.
5. Add it to the renderer's `ProviderId` type and provider list/labels in
   `App.tsx` (search `ProviderId` near `App.tsx:177`) so Settings can show
   it and `metisSecrets` can manage its key.

**A new IPC channel**
1. Decide whether it belongs on an existing `window.metisXxx` bridge or
   needs a new one - a new domain gets its own `contextBridge.exposeInMainWorld("metisYourThing", { ... })` block in `src/electron/preload.cts`, following the pattern of the existing blocks.
2. Add the matching `ipcMain.handle`/`ipcMain.on` registration inline inside
   `app.whenReady().then(async () => { ... })` in `main.ts`, starting around
   `main.ts:9579`.
3. Add the `Window.metisYourThing?` type to `src/renderer/global.d.ts`,
   mirroring the preload signature exactly.
4. Add any new payload/result shapes to `src/shared/runtime-contracts.ts`
   so both sides import the same type.

**A new store-backed setting**
1. Pick a unique key (must match `storeKeyPattern`, checked in `storePath()`
   at `main.ts:524`) - no schema registration needed beyond that; it's just
   a JSON file at `metis-store/<key>.json`.
2. If main needs to read it during a run, call `readStoreValue<T>(key,
   fallback)` at the point of use (see `prewarmEnabled`,
   `main.ts:7758`, for the pattern).
3. If it's a UI-owned preference, read/write it from the renderer with
   `useAppStoreState<T>(key, fallback)` (`App.tsx:1439`) instead - don't add
   a main.ts read path unless main actually needs the value during a run.
4. If both sides need it (like `prewarmEnabled`), do both, and re-check it
   on the main side even when the renderer is expected to gate its own IPC
   call first - defense in depth, per `docs/ORACLE.md`.

**A new nav view**
1. Add the key to `NavKey` in `App.tsx:157`.
2. Add a `<NavButton>` for it in the sidebar (see the block starting around
   `App.tsx:2765`).
3. Add its `{activeNav === "yourKey" ? <YourWorkspace /> : null}` branch in
   `App()`'s render (see the block starting around `App.tsx:1873`).
4. Add it to `PALETTE_VIEWS` (`App.tsx:163`) so Ctrl/Cmd+K's command palette
   can jump to it.
