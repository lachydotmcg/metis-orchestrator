# Metis Agentic Roadmap

Written 2026-07-02. Maps the agentic feature plan onto what actually exists in this repo, so any
session (Claude, Codex, or future-you) can pick up mid-stream. Statuses: DONE / PARTIAL / TODO.

Primary product goal: **the chat experience**. Every feature below is judged by how it lands in the
conversation surface (New session workspace in `src/renderer/ui/App.tsx`).

---

## 1. What already exists (don't rebuild these)

| Capability | Where | Status |
| --- | --- | --- |
| Live streaming (message/thought deltas, stages, steps, operations, timeline) | `main.ts` `emitStream` -> `metis-session:stream-event` -> `preload.cts` `runStream` -> `App.tsx` `applyStreamEventToTurn` + `LiveRunTimeline` | DONE |
| Claude-Code-style operation rows ("Created X", "Edited Y", +N/-N diff stats, command exit codes, browser checks, filters All/Files/Checks/Issues) | `AgentOperation` in `runtime-contracts.ts`; `OperationRow`/`OperationTimeline`/`timelineOperationLabel` in `App.tsx` | DONE |
| Thought blocks (CoT) | `thought_delta` stream event -> `ModelThoughts` collapsible | DONE (visible-when-provided; not forced pre-tool) |
| Multi-model build pipeline w/ fallback cascade (plan -> frontend -> functional, primary -> fallback -> local) | `runOrchestratedStages`, `callStageWithFallback`, `defaultAgenticStages` in `main.ts` | DONE |
| Real file writes + preview + verification (syntax, HTTP check, console errors, screenshots) | `writeProjectFiles`, `buildProjectToolResult`, `ProjectToolResult` | DONE |
| Pipeline step checklist in-chat (route trace box) | `SessionPipelineStep`, `PipelineSteps` | DONE |
| Permission gating (scoped grants: filesystem.read/write, process.spawn, network.*) | `metisPermissions`, `PermissionScope` | DONE (foundation) |
| Audit log | `metisAudit`, `appendAudit` | DONE |
| Project context snippets (lightweight RAG-ish retrieval) | `ProjectContextSnippet`, `projectContextSnippets` on `SessionRun` | PARTIAL (keyword score, not vectors) |
| Model picker UI (Cloud/Local -> brand -> model, custom add, persisted) | `App.tsx` `modelGroups`, `customModels` | UI DONE, **not wired to routing** |

## 2. Immediate work (this week's order)

1. **Wire model override end-to-end** — DONE 2026-07-02. `SessionModelOverride` in contracts;
   `submitPrompt` sends it; `resolveOverrideModel` normalizes display names -> API ids; chat path
   bypasses the router; build path prepends the pinned model to every stage chain; bad custom model
   falls back to the provider default with a warning.
2. **Directive bus phase 1** — DONE 2026-07-02 (see section 3; phases 2-3 remain).
3. **Self-healing verify->repair loop** — DONE 2026-07-02. `runRepairPasses` in `main.ts`: when
   post-write verification fails, the failure evidence (verificationDetail, console errors, failed
   command stderr) + current file contents go to a repair chain (pinned model first if overridden,
   else DeepSeek -> Claude -> local), corrected files are merged + rewritten + re-verified, max 2
   passes, each visible as a live "Repair pass N" stage in chat. Summary text + warnings reflect it.
4. **Verify streaming + override + steering + repair in the running Electron app** (renderer preview
   can't exercise them — no `window.metisSession` there). Manual: `npm run dev`, "build me a small
   site", pin a model, steer mid-run, watch live stages/operations.
5. **3-dot menu on conversation tabs** (file/context actions; replaces the removed folder chips).
6. **Graph-driven per-stage models** — `defaultAgenticStages` is hardcoded; read the orchestration graph nodes + fallback edges instead.

## 3. The multi-session live-collab idea (design, not yet built)

Goal: open a second session window on the same project while a run is in flight; say "skip b, add d";
the running agent absorbs it mid-run and both sessions see each other's activity.

Design — **Directive Bus** (phase 1 is genuinely buildable now because stages are sequential awaits):

```ts
interface SessionDirective {
  id: string;
  projectPath: string;
  fromConversationId?: string;
  createdAt: string;
  text: string;                       // "skip b, rework it as a modal instead"
  status: "pending" | "applied" | "declined" | "superseded";
}
```

- Main process keeps `directives: Map<projectPath, SessionDirective[]>` + persists to the app data dir.
- IPC: `metis-bus:post`, `metis-bus:list`, and a broadcast `metis-bus:event` sent to **all** BrowserWindows.
- `runOrchestratedStages` calls `drainDirectives(projectPath)` **between stages**; pending directives are
  folded into the next stage prompt ("Mid-run direction from the user: ..."), then marked `applied` and
  emitted as a timeline event: `Picked up direction: "skip b, add d"`.
- Phase 2: multiple windows — `File > New window` opens another BrowserWindow; main-process state is
  naturally shared, so the bus, conversations, and permissions all just work. Each window is a session.
- Phase 3: concurrent runs on one project — per-file soft locks; escalate to git worktree isolation
  (below) when two runs want the same file.

## 4. Rest of the plan, mapped

- **Agentic execution loop (/loop, self-healing)** — SHIPPED 2026-07-02 as `runRepairPasses`
  (section 2 item 3). Future extension: also run it for the non-build chat path's
  `createFrontendProject` writes, and let repair passes run project commands (tests) as evidence.
- **Task-level abstraction planner** — the plan stage already produces a plan; parse it into checklist
  items (`SessionPipelineStep[]`) and tick them as stages/operations complete. Mostly a prompt + parse
  change; UI already renders steps.
- **Session init hooks (METIS.md)** — on run start, look for `METIS.md` in the selected project root and
  prepend it to every stage/system prompt; emit a `context_load` operation ("Read METIS.md") so it shows
  in chat like Claude Code's "Read" lines.
- **Progressive-disclosure skills** — registry packages of kind `skill` already exist (`metisRegistry`);
  give installed skills a trigger-keyword list and inject only matching skills into stage prompts.
- **Vector codebase index** — upgrade `ProjectContextSnippet` scoring from keyword to embeddings
  (local: Ollama `nomic-embed-text`; keep keyword fallback). Emit `context_load` operations for the
  snippets used ("Read src/foo.ts (3 snippets)").
- **Git worktree isolation** — `AgentOperationKind` already has `git`. Add `metis-git` IPC (status,
  branch, worktree add/remove); build-pipeline option "run in isolated worktree", merge on accept.
- **Context-isolated subagents / fan-out fan-in** — a stage whose prompt asks for a task split
  (JSON envelope), then N parallel `callStageWithFallback` calls with *clean* prompts, then a synthesis
  stage. Envelope format = "structured delegation protocol". Render as parallel stage blocks.
- **Smart model routing** — this IS Metis Policy; the graph editor + policy CLI already route. Extend
  with per-task-complexity tiers once graph-driven stages land (item 2.4).
- **MCP clients** — `mcp.invoke` permission scope + `mcp_call` operation kind already reserved. Adopt
  the MCP SDK in main, register servers in Settings, expose tools to stages.
- **Sandboxed execution** — commands currently run via `maybeRunRequestedProjectCommand` with
  permission gates; harden later (job objects on Windows / containers), keep the permission ceremony.
- **Computer use / headless browser** — `browser_check` verification already loads previews and captures
  screenshots + console errors; extend to scripted interactions later.
- **Artifacts panel** — `ProjectArtifacts` renders in-chat; a dedicated right-rail panel can reuse the
  same data (`ProjectToolResult.artifacts`).
- **Interactive live diffs (accept/reject)** — before `writeProjectFiles` in `selected-project` mode,
  stream a `diff_pending` event with old/new content; chat shows Accept/Reject; main awaits the verdict.
  Requires holding the run open on a promise — doable with the stream controller.
- **Permission modes (read-only / semi / swarm)** — `permissionLevel` (`restricted|standard|trusted`)
  already flows through `SessionRunInput`; surface it as the three modes and gate writes/commands on it.
- **Inline plan feedback** — once the plan renders as a checklist, add a per-item comment box that posts
  a `SessionDirective` (reuses the bus from section 3).

## 5. Verification notes

- Renderer-only preview (`metis-renderer` launch) has **no** `window.metis*` bridges — chat falls back to
  `makePreviewRun`. Streaming/orchestration can only be verified in the real app: `npm run dev`.
- `npm run build` = typecheck + vite + electron build. Main-process changes need a full Electron restart.
- Codex edits this repo between sessions. **Re-read files before editing.**
