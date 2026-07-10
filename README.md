<!-- LOGO HERE -->

# Metis Orchestrator

Metis Orchestrator is the desktop runtime of the Metis stack: a local-first AI orchestration studio where you wire a pipeline on a visual graph and watch real multi-model builds happen. It routes for quality, cost, and quota so local work stays free and private, escalating to the cloud only when a prompt actually needs it.

## The Metis stack

Metis is three layers, one story:

- **Metis Benchmark** measures local models: quality x hardware x dollars.
- **Metis Policy** is the routing brain the benchmark proved out.
- **Metis Orchestrator** (this app) is where that policy actually runs.

## Feature tour

### Orchestration graph
Build a pipeline visually with router, agent, and skill nodes. Each node gets its own model, gateway, and fallback chain, and you can save presets or fire a quick Run Test without a full build.

<!-- SCREENSHOT: Orchestration graph view -->

### Build pipeline
Runs go plan, then frontend, then functional, writing real files into your project folder. Builds verify themselves and self-repair when something's off, and edit an existing folder in place instead of clobbering it. Permission modes control how much the app is allowed to do unattended, and every model call gets its own visible side-chat so you can see what each stage actually said.

<!-- SCREENSHOT: Build pipeline in progress -->

### Chat with attachments
Talk to the orchestrator directly. Drop in an image and it routes to a vision-capable model automatically.

<!-- SCREENSHOT: Chat with an image attachment -->

### Knowledge Banks
Local embeddings over your project files ground the pipeline's prompts in what's actually in the repo, not just what's in the conversation.

<!-- SCREENSHOT: Knowledge Banks panel -->

### Gallery style memory
Drop in reference images and they become style cards the pipeline retrieves from at build time, so a project can inherit a look instead of defaulting to generic AI-slop design.

<!-- SCREENSHOT: Gallery board -->

### Graph View
A force-directed memory graph backed by a real file directory. Open and edit documents right there in the graph.

<!-- SCREENSHOT: Graph View -->

### Manager
A chat assistant that knows your projects and to-dos, plus a floating widget you can carry anywhere on screen.

<!-- SCREENSHOT: Manager widget -->

### To-Do board
Tasks can be assigned to you, the Manager, a conversation, or an agent, so work started in chat doesn't just evaporate.

<!-- SCREENSHOT: To-Do board -->

### Marketplace and registry
GitHub-native: browse, install, star, and publish skills, MCP connections, and presets, all reviewed and merged by pull request.

<!-- SCREENSHOT: Marketplace -->

### Benchmark onboarding
Hardware-matched local model recommendations with one-click Ollama installs, so you're running the right model for your machine from the start.

<!-- SCREENSHOT: Benchmark onboarding -->

### Pulse
A community feed for what's new across Metis.

### Routines
Scheduled runs, for pipelines you want happening on a timer instead of by hand.

### Settings
Appearance, chat behaviour, MCP servers, privacy, and an About section with update checks.

## Getting started

Prerequisites:
- Node 18+ (the repo targets Node 20 in `engines`)
- Optionally, [Ollama](https://ollama.com) for local models, and API keys for any cloud providers you want to use

```bash
npm install
npm run dev     # Vite dev server + Electron, hot-reloading
npm run build   # typecheck, build the renderer, and compile the Electron main process
```

Provider API keys are entered in **Settings > Providers**. Local models come from the Benchmark's install flow, or by running `ollama pull <model>` yourself.

## Architecture overview

- **Electron main process** (`src/electron/main.ts`): providers, routing, the build pipeline, and IPC to the renderer.
- **Renderer** (`src/renderer/ui/App.tsx`): React 18 + Vite.
- **Shared contracts** (`src/shared/runtime-contracts.ts`): the types both sides agree on.
- **Registry** ([github.com/lachydotmcg/metis-registry](https://github.com/lachydotmcg/metis-registry)): the model catalog, marketplace packages, and Pulse feed, served from a separate repo.

## Publishing to the marketplace

The in-app Publish wizard generates a manifest for your skill, MCP connection, or preset and opens a pre-filled GitHub pull request against the registry for review. Anything you build stays personal until you publish it: installing is for your own setup, publishing is what makes it shared with everyone else.

## Roadmap

The active plan lives in [`docs/DRILL_PLAN.md`](docs/DRILL_PLAN.md), with feature designs in [`docs/FABLE_PLANS.md`](docs/FABLE_PLANS.md).

## Status

Pre-release and moving fast. Built by Lachy, solo founder, with an AI coordinator + implementer workflow.
