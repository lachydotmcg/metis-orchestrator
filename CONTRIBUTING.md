# Contributing to Metis Orchestrator

Thanks for looking at the code. This doc gets you from a fresh clone to a
running dev build to a merged change. For the deep technical map (process
model, IPC surface, store keys, run pipeline), see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - that file is kept accurate
against the real code and this one leans on it rather than repeating it.

## Getting started

Prerequisites:

- **Node 20+** (the `engines` field in `package.json` requires `>=20`).
- Optionally, [Ollama](https://ollama.com) if you want to run local models
  during development.
- Cloud provider API keys are **not** environment variables - they're
  entered at runtime in the app, under **Settings -> Providers**.

Clone the repo, then:

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server on `127.0.0.1:5177`, waits for it,
compiles the Electron main process, and launches the app pointed at that dev
server with hot reloading.

Other scripts you'll actually use, copied straight from `package.json`:

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite + Electron, hot-reloading. Your everyday dev loop. |
| `npm run build` | `typecheck` -> `vite build` (renderer) -> `build:electron` (main process). The full production build - this is the one that has to pass before you commit. |
| `npm run typecheck` | Type-checks the renderer and the electron/shared tree, both `--noEmit`, no output written. Faster than a full build if you just want a type-error check. |
| `npm run build:electron` | Compiles `src/electron/**` and `src/shared/**` with `tsc -p tsconfig.electron.json`. |
| `npm start` | `build` then `electron .` - a non-dev production-mode launch. |
| `npm run preview` | `vite preview` on port 4177, renderer only, no Electron shell. |
| `npm run pack` | `electron-builder --dir` - unpacked app under `release/`, no installer. Needs `electron-builder` installed locally first (see [`docs/RELEASING.md`](docs/RELEASING.md)). |
| `npm run dist` | Full build plus real installers under `release/`. Same local-install caveat as `pack`. |

There's no separate lint script in `package.json` right now - `typecheck`
and `build` are the gates.

## Project layout

The full map, with real function names and line numbers, lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The short version, one line
per file that matters most:

- `src/electron/main.ts` - the Electron main process: every IPC handler,
  the run pipeline (chat, build, fan-out), providers, routing, the
  JSON-file stores, and the audit log. Full Node/OS access.
- `src/electron/preload.cts` - the only bridge between main and renderer.
  Every capability the UI can call is an explicit
  `contextBridge.exposeInMainWorld("metisXxx", { ... })` block here.
- `src/renderer/ui/App.tsx` - the React 18 renderer, one file, owns all UI
  state and talks to main exclusively through `window.metisXxx`.
- `src/shared/runtime-contracts.ts` - the types both sides import, so the
  IPC contract between main and renderer can't silently drift.

If you're touching Oracle (the speculative prewarm/draft engine), read
[`docs/ORACLE.md`](docs/ORACLE.md) first - it's the source of truth for
that feature.

## How changes are built here

Worth being upfront about: this project's actual development model is a
coordinator + implementer workflow - a coordinator model plans and verifies
work, and sub-agents do the implementation. That's genuinely how most of
this codebase gets written day to day.

Whether a change comes from that workflow or from a human typing directly,
the same practical rules apply before it lands:

- `npm run build` must exit `0` before you commit. There's no PR-time CI
  gate in this repo yet (`.github/workflows/release.yml` only runs on
  version tags for cutting releases), so this check is on you.
- Keep shared contracts (`src/shared/runtime-contracts.ts`) additive and
  back-compatible. Add fields and types; don't repurpose or remove ones
  another in-flight change might depend on.
- Match the existing UI aesthetic: slim, greyscale, no unnecessary chrome.
- No em dashes in user-facing copy (UI strings, error messages, docs
  written for users). Spaced hyphens or arrows for menu paths are fine.

## Code style and conventions

- **TypeScript strict** throughout - both the renderer (`tsconfig.json`)
  and the electron/shared tree (`tsconfig.electron.json`).
- **Persisted state** goes through the store primitives in `main.ts`:
  `readStoreValue<T>(key, fallback)` / `writeStoreValue<T>(key, value)` on
  the main side, `useAppStoreState<T>(key, fallback)` on the renderer side.
  Both write to `metis-store/<key>.json` under Electron's `userData` path.
  Don't invent a parallel persistence mechanism.
- **New IPC** always goes through both `preload.cts` and
  `src/renderer/global.d.ts` together - add the `contextBridge` call, the
  matching `Window.metisYourThing?` type, and the `ipcMain.handle`/`.on`
  registration in `main.ts`. See "Where to add things" in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the exact pattern and
  line references.
- **No new dependencies without reason.** The dependency list is
  deliberately small; if you're adding one, be ready to say in the PR why
  it's needed over what's already available.
- **Honest disabled states over fake buttons.** If a feature isn't wired
  up yet, disable the control (with a reason, if there's room) rather than
  shipping something that looks live and does nothing.

## Publishing to the marketplace

Skills, MCP connections, and presets are not code changes to this repo -
they're published through the in-app **Publish wizard**, which generates a
manifest and opens a pre-filled pull request against the separate
[`metis-registry`](https://github.com/lachydotmcg/metis-registry) repo. If
you're contributing a marketplace package, that's where the PR goes.

Code changes to the Orchestrator app itself (this repo) are regular pull
requests here.

## Releasing

Releasing is a separate, deliberate process (version bump, tag, GitHub
Actions build across all three OSes). See
[`docs/RELEASING.md`](docs/RELEASING.md) for the exact steps - contributors
generally won't need to cut a release themselves.

## Code of conduct

Be decent. Disagree about the code, not the person. Assume good faith,
give specific and actionable feedback, and don't be a jerk about it.
