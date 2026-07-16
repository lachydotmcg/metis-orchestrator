# LIVE TESTS — the walk-through (2026-07-16)

Everything here shipped green on `npm run build` but has never been touched in the real
Electron app. Work top to bottom; each test says exactly what to do and what you should see.
Check them off as you go, and jot anything weird next to the box — a one-word note is enough
for the next drill to act on.

Prep once: `npm run dev`, Ollama running with your usual model pulled, DeepSeek key saved in
Settings > Providers.

---

## 1. Per-model gateways (the big rework)

- [ ] **Click vs drag in the Library.** Orchestration > Library > Models tab. Click a model
  WITHOUT moving the mouse: the side panel should swap to that model's gateway panel (logo,
  name, Gateway dropdown, gateway fallbacks). Now drag a model a few pixels: the ghost drag
  should start and drop onto a node exactly like before. The boundary is 5px of travel.
- [ ] **DeepSeek shows every real route.** Click DeepSeek V4 Flash in the Library. The Gateway
  dropdown should offer Auto + DeepSeek + NVIDIA NIM + OpenRouter (this was the original bug:
  it only ever showed DeepSeek).
- [ ] **No more Grok imposter.** Click any Claude model. Gateway options should read
  Claude + OpenRouter. If you see "Grok" anywhere in a gateway list, that fix regressed.
- [ ] **Config is per-MODEL, globally.** Set DeepSeek V4 Flash's gateway to NVIDIA in the
  Library, then look at a node using it in orchestration and run a build/test — the route
  should honor NVIDIA wherever that model appears. The node inspector itself should show NO
  gateway section anymore, just a hint pointing at the Library.
- [ ] **Kimi + Llama sanity.** Kimi K2.6 should offer OpenRouter + Groq; Llama 3.3 70B should
  offer Groq + NVIDIA + OpenRouter.
- [ ] **Open-weight models gained cloud escape hatches.** gpt-oss 20B/120B and DeepSeek R1
  Distill 70B (Local tier) should list Groq/NVIDIA/OpenRouter routes after their Ollama route.
  Local must stay first: with Ollama running, a run on these should still go local.

## 2. Depths

- [ ] **L3 is your base model.** Enable depths on a node. The L3 row should show that node's
  own model with its logo and "· base" — not "Strongest cloud (default)".
- [ ] **Drag-drop follows.** With depths enabled, drag a DIFFERENT model onto the node. The L3
  row should update to the new model (give the debounce a second), inspector open or closed.
- [ ] **A heavy prompt routes deep.** Depth routing on, Auto Router, ask something genuinely
  architectural. Timeline should show the router's depth call and the run should land on your
  L3 model. A one-liner tweak should land shallow (L1 / router).

## 3. Cloud Oracle (O5) — the money one

- [ ] **The toggles gate it.** Settings > Chat > Experiments: "Cloud Oracle via DeepSeek"
  should exist with the cost warning. With it OFF and a DeepSeek model pinned, typing must
  produce ZERO DeepSeek API calls (check your DeepSeek usage dashboard if paranoid — this is
  the never-spend-silently guarantee).
- [ ] **Instant serve via the cloud.** Both toggles ON, pin DeepSeek V4 Flash, type a real
  question, pause 2+ seconds (watch the Oracle chip), then send WITHOUT editing. Expect
  "Oracle answered instantly, Xms" with a sub-second first token. Then edit one word and send:
  it should fall back to a normal call, never serve the stale draft.
- [ ] **Send never queues.** Type, pause (draft starts), then immediately send a different
  prompt. First token should NOT stall behind the speculative call.

## 4. Oracle draft streaming (I9.2) + open-prewarm (I9.1)

- [ ] **The guess forms live.** Prewarm on, pin a local model, open the Oracle chip popover,
  type and pause. The guess should STREAM into the popover word by word — thinking first if
  it's a reasoning model — instead of appearing all at once.
- [ ] **Warm before you type.** Open an existing conversation that has a pinned local model.
  The Oracle chip should flash "warming" within ~a second of the conversation opening, before
  you touch the keyboard. First keystroke response should feel warm.

## 5. MCP tools in runs (P10.2)

- [ ] **Flag surface.** Settings > MCP servers: "Let runs use MCP tools (experimental)" toggle
  exists, default off.
- [ ] **A real tool call.** Install an MCP server from the Marketplace (filesystem or fetch is
  easiest), Test-connection it, flip the toggle ON, then in chat ask something that needs the
  tool ("use the fetch tool to get example.com and summarize it"). Expect: a timeline line
  listing available MCP tools at the start, then "MCP tool X (server) returned in Nms" when it
  fires, and the answer actually using the result. Known v1 quirk: the model's raw JSON tool
  directive may briefly stream into the reply before the continuation replaces it.
- [ ] **Fail-soft.** Kill/misconfigure the server and ask again: the run should complete with
  the model told the tool failed — never a crashed run.

## 6. Headless / service mode (P10.5)

- [ ] **Toggle + relaunch.** Settings > Window: "Start minimized to tray" ON, quit fully,
  relaunch. No window should appear; the tray icon should be there; clicking it opens the
  window normally.
- [ ] **Gateway serves headless.** With the Gateway enabled too, while headless run:
  `curl http://127.0.0.1:11500/v1/models -H "Authorization: Bearer <your token>"` — it should
  answer without the window ever opening.
- [ ] **`--headless` flag.** Toggle OFF, launch with `--headless` — same hidden start.

## 7. Routines dry run (I9.4)

- [ ] **Preview without consequences.** Routines: every card should have an Eye button. Dry-run
  a build-ish routine ("tidy up the README in <project>"). Expect: spinner, then it jumps to a
  FRESH conversation showing the plan — and stops there. No files written, the routine's own
  lastRun/nextRun untouched.

## 8. Conversation forking (I9.5) + /handoff (I9.10)

- [ ] **Fork and compare.** Open a conversation with a few turns, context menu (…) > Fork. You
  should land in "<title> (fork)" with the full history and the same pinned model. Pick a
  DIFFERENT model in the fork, re-ask, compare. Delete the FORK afterward and confirm the
  ORIGINAL's turns and run metadata survive (this was the dangerous edge; it's guarded).
- [ ] **/handoff.** In a real working conversation type `/han`, pick the row. Expect a terse
  markdown brief (what/decisions/state/next steps) as a normal assistant turn you can copy.

## 9. Pipeline warm-chain (I9.3)

- [ ] **Stage 2 starts warm.** Prewarm on. Build a graph whose plan stage and frontend stage
  use two DIFFERENT local models, run a build, watch the stage handoff — stage 2's first
  token should come noticeably faster than a cold load of that model normally takes (the
  second model loads while stage 1 streams).

## 10. Knowledge provenance (I9.7)

- [ ] **Which chunks, exactly.** In a project with the knowledge bank indexed (needs
  `ollama pull nomic-embed-text`), ask a question about the project. Expand the "Grounded on
  N chunks" row: it should now list each chunk as `file #n — preview…` instead of just a
  comma-joined file list.

---

## Quick regression sweeps (5 minutes, things the rework touched)

- [ ] Dragging a NODE on the canvas still feels right (nodes now don't move until 5px of
  travel — a plain click should select without the node twitching).
- [ ] Model fallback chain add/promote/remove in the node inspector still works (promote now
  carries gateway configs with the models).
- [ ] The composer "via Provider" suffix on multi-route models reads OpenRouter/NVIDIA/Groq
  correctly (same brand fix as the gateway picker).
- [ ] A plain chat on Auto Router with every new flag OFF behaves exactly like last week —
  the whole batch is supposed to be invisible until opted into.
