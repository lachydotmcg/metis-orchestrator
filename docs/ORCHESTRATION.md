# Real multi-model orchestration — design (the actual engine)

## STATUS: v1 BUILT (2026-06-29, non-streaming)

Shipped: `runOrchestratedStages()` in `main.ts` runs **Plan → Front end → Functional**
as three REAL chained provider calls (stage N's output feeds N+1). Each stage has a
**fallback chain**: primary → fallback → local Ollama, recording red "falling back to
…" notes (`OrchestrationStage.fallbackNotes`). Triggered by `shouldRunAgenticPipeline`
("build/make/create a site/app/page…"). Renderer (`CompletedRun`) shows each stage as
its own `.stage-block` (model label + red fallback notes + output). Default mapping:
Plan=Gemini→Claude→local, Front end=Claude→DeepSeek→local, Functional=DeepSeek→Claude→local.

**DONE since:** the pipeline now **actually writes files** — `extractProjectFiles()`
pulls labeled/inferred files out of the stage code blocks and `writeProjectFiles()`
writes them into the selected workspace (or app-managed if no folder), attaching a
`projectResult` the UI renders. Stage prompts now demand complete, path-labeled files.

**Still TODO (next increments):**
1. **Streaming** — currently all 3 stages run then appear together (~10-40s). Add
   `metis-session:event` IPC so each stage posts live ("communicate throughout").
2. **Graph-driven models** — stage models should come from the orchestration graph
   nodes + their fallback chains, not the hardcoded default in `defaultAgenticStages()`.
3. **Start a live preview** for the written project (run `node server.js` / static
   serve) and verify it, like `createFrontendProject` does for the single path.
4. Persist stages into the conversation record so reopening a chat shows them.

---

# Original design notes


## The problem today

`runSession` makes **one** provider call. When you ask it to build a site, the
single routed model (e.g. DeepSeek on the "Back End" route) *writes a plan that
fakes* "ask Gemini → Claude builds → DeepSeek makes it functional" and then stops.
Nothing is actually orchestrated. That's why it dumps a wall of text and ends after
"planning". (Stop-gaps already shipped: removed the `{provider} output` label;
system prompt now forbids a single model from roleplaying other models.)

## What you want (agentic pipeline)

For a buildable task (e.g. "make me a small site"):

1. **Plan** — Gemini drafts the spec/plan. → posts a short message to the feed.
2. **Front end** — Claude builds the UI from the plan. → posts a message + the files.
3. **Make functional** — DeepSeek wires up the backend/interactivity. → posts a message + files.
4. The Manager/orchestrator **talks to you between stages**, not one dump at the end.

Each stage is its own concise message in the timeline; you can watch it progress.

## How I'd build it

- **A staged runner** in `main.ts`: `runOrchestratedSession()` runs an ordered list
  of stages, each = `{ id, label, provider, model, promptTemplate }`. Stage N's
  output feeds stage N+1's prompt (plan → build → wire up).
- **Streaming**: emit a `metis-session:event` IPC message as each stage starts and
  finishes (`stage-start`, `stage-message`, `stage-complete`), so the renderer
  appends each stage as its own message live — the "communicate throughout". (New
  preload listener + a renderer subscription; the feed already renders a list of turns.)
- **Stage → provider mapping** (default): Plan = Gemini, Front end = Claude (Anthropic),
  Functional = DeepSeek. Falls back to the local model / whatever key exists if a
  provider isn't configured, and says so in that stage's message.
- **Trigger**: only run the full pipeline for clearly buildable requests
  ("build/make/create a site/app/page"); everything else stays a normal single reply.
- Reuses the existing project-tools (file writes + preview) for the build stages.

## Open decisions (need your call before I build)

1. **Keys** — the real pipeline calls Gemini + Claude + DeepSeek. You have DeepSeek.
   Do you have **Gemini** and **Anthropic** keys to add in Settings, or should those
   stages fall back to your **local model** (Ollama) for now so the whole flow runs
   end-to-end without cloud keys?
2. **Trigger scope** — pipeline only on explicit "build me X" requests (recommended),
   or also when you say "test the front end pipeline" etc.?

Once you answer, I build the staged runner + streaming + the live timeline.
