# Metis Orchestrator Next Steps

Source: user notes after a Claude design pass, 2026-06-28.

Status: immediate UI fixes from this list were implemented or seeded on
2026-06-28. Product semantics and deeper integrations remain planning notes.

## Immediate UI Fixes

- [x] The close `x` control looks visually off. Fix its alignment and hit area.
- [x] Dragging around the map while customizing a node can send the interaction back
   to the library. Keep drag state anchored to the graph canvas.
- [x] Dropping a skill should not require getting extremely close to the agent node.
   Dropping onto a connection line should insert the skill into that route.
- [x] Connector shape should be one line from router, split into two skill branches,
   then merge back into one line into the agent. Avoid separate unrelated lines.
- [x] Add a preset library, similar in spirit to the skills preset area.
- [x] Remove the Chat and Code buttons. They do not serve a purpose in this app.
- [x] Remove Dispatch from the sidebar for now.
- [x] Let clicking the Metis project folder expand the conversations/logs inline
   under that folder in the left sidebar.
- [x] Remove the lime color scheme. Use a quieter neutral graph language.
- [x] Add a Test Route action for validating an orchestration path.
- [x] Add a Benchmark section later.
- [x] Replace Connections with Marketplace in the left navigation.
- [x] Let dropped model cards create a new routed agent when placed on empty
  canvas.
- [x] Make the sidebar collapsible.
- [x] Make the right Library / inspector rail collapsible.
- [x] Start Graph View as a separate Obsidian-style note/file graph surface.

## Product Semantics

- The current canvas is Orchestration, not Graph View.
- Agent runs need an **operation timeline** inside conversations. The route
  metadata alone is not enough. When the agent edits files, runs commands, opens
  a browser, uses computer control, or verifies a UI, the conversation should
  show compact action rows similar to a merge request/check log:
  - pencil icon: `Edited <file name>` with `+00` / `-00` line counts
  - terminal icon: `Ran <command>` with exit status and expandable output
  - browser icon: `Opened / checked <url>` with console/screenshot status
  - file/folder icon: `Created <path>` or `Added <directory>`
  - warning/error icon: failed command, blocked permission, missing API key
- The operation timeline now has filters for All, Files, Checks, and Issues.
  Claude can tighten the visual treatment, but the runtime/UI contract is in
  place for richer file, terminal, browser, MCP, and git actions.
- Generated frontend project runs now include real evidence: file writes,
  `node --check script.js`, hidden-browser preview verification, console error
  capture, and a screenshot path on the browser-check operation.
- Generated source from a model must become real files, not chat prose and not
  a canned template preview. The Electron project-tools layer now extracts
  fenced files or raw `<!doctype html>` output, writes them into the selected
  project folder when available, records create/edit line counts, and keeps the
  raw provider source in `metis-brief.md`.
- Session runs now have an ordered timeline event shape for text, route,
  stage, and operation events. This is the contract for rendering "assistant
  says a thing -> tool/model call happens -> assistant continues" instead of
  attaching every project tool receipt at the end of the message.
- Live session streaming over IPC is now started: `metisSession.runStream`
  pushes timeline, stage, operation, project, and completion events into the
  pending turn while Electron is still running. This is visible work/status
  streaming, not private chain-of-thought exposure. Next backend additions are
  cancellation, recovery, and first-class question events.
- Ollama/Qwen text streaming now separates model-emitted `<think>` content from
  the visible answer. The chat answer updates as tokens arrive, and local-model
  thoughts appear in a collapsible disclosure underneath when the model actually
  sends them.
- Generated `index.html` is now required to be structurally complete before it
  is accepted for preview (`html`, `body`, and closing tags). This prevents
  truncated model output from becoming a blank or half-styled preview.
- Graph View now overlays recent stored conversations, session runs, and their
  operations as runtime memory nodes. Conversation/run/operation nodes can link
  back to the stored conversation, so the graph is becoming a usable trace map.
- Ordinary chat runs can now trigger conservative project commands when asked:
  `npm run test --if-present`, `npm run build --if-present`, or
  `npm run lint --if-present` in the selected project folder. This is not
  arbitrary shell execution yet.
- Selected project folders now produce a lightweight project snapshot: package
  manager, scripts, dependency clues, capped file tree, and scan warnings. The
  snapshot is shown in New Session, injected into routed model prompts, stored
  on session runs, and visualized in Graph View.
- Authorship of the **message body** must be visually distinct from route
  metadata. If the displayed words are raw output from DeepSeek, Sonnet, Qwen,
  etc., the message itself should show that as the speaker/source. If Metis
  synthesized or rewrote another model's output, the message should say so on
  the message surface. Do not bury this as a disclaimer inside the route
  expansion.
- The Orchestration UI must eventually apply to the real routing policy. The
  graph should persist/export into the Metis Policy contract rather than remain
  a purely visual editor.
- Current renderer work should carry across to the desktop application because
  the Electron app loads the same React/Vite renderer. Native desktop concerns
  such as filesystem scans, encrypted API-key storage, and provider calls should
  be added through the Electron main/preload boundary later.
- Graph View should mean an Obsidian-like graph of logs, conversations, project
  files, memory notes, and links. Its purpose is traceability and token
  optimization: traverse relevant links instead of loading whole documents.
- Graph View should scan and visualize linked `.md`, `.txt`, logs, and project
  files as nodes. Users should be able to zoom out for the whole map and zoom in
  for note/file detail, similar to Obsidian's graph view.
- Gallery is effectively a specialized skill/reference library for frontend
  design. Users should be able to drop in design references, classify them
  manually or with a model, and later route frontend work through those
  references. Pinterest-board import is a desired future capability.
- Presets, skills, MCP connections, and orchestration templates may all belong
  in one marketplace-like library. The marketplace is essentially a way to share
  orchestration layers.
- Marketplace should be a primary left-nav section, replacing the old
  Connections tab. It should include skills, MCP connections, presets, full
  orchestration templates, and eventually local-cluster routing packages.
- Marketplace cards should eventually support real registry/GitHub-sourced
  images, icons, screenshots, and provenance metadata once the storage and
  submission format is designed. Until then, local generated thumbnails are
  acceptable for the prototype.
- Save/load is important for presets and should connect naturally to the
  marketplace concept.
- The app should eventually include a built-in orchestration manager AI: an
  assistant that can inspect the graph, suggest changes, manage specialist
  subagents, explain routing decisions, and use the logs/Graph View as linked
  project memory instead of acting like a normal code IDE.
- That manager AI should eventually connect to user-approved communication
  channels such as Telegram, Discord, email/Gmail, and scheduled notifications.
  Treat this as a security-sensitive integration layer: explicit permissions,
  scoped credentials, audit logs, and no silent message sending.
- Explore structured model-to-model prompting inside the orchestration
  customizer: a prompt could pass through configurable planning, retrieval,
  critique, or specialist stages. Keep the router as the decision layer, but let
  the UI represent deliberate multi-model chains where useful.
- Settings should include editable environment variables/API credentials at the
  provider level. A user should set `ANTHROPIC_API_KEY` once for Claude models,
  `OPENAI_API_KEY` once for OpenAI models, etc., rather than entering keys per
  node. If a subscription-backed provider is active, those fields can be filled
  or hidden, but open-source users should be able to bring their own keys.
- Future local AI enthusiast feature: delegate local task calls to clusters,
  servers, or other PCs the user owns.
- Goals: sessions should be able to run toward a declared goal and keep
  passively prompting/iterating until the goal is complete, blocked, canceled,
  or a budget/permission limit is reached. This needs visible state, audit
  records, retry policy, and a clear "why it stopped" explanation.
- Questions: agents need a first-class event for asking the user questions.
  Questions should pause or branch the run, carry enough context to answer
  quickly, and resume the goal/task after the user responds.
- Side chats and parallel agents: users should eventually be able to select a
  message span and open a linked side conversation, then optionally promote that
  thread into a parallel specialist agent. Parallel agents should keep shared
  project context, produce their own auditable operation timelines, and merge
  outcomes back into the main conversation only with clear authorship/source
  labels.
- Late-stage publicity idea: explore an optional idle-game layer once the core
  benchmark, routing, gallery, marketplace, manager, and desktop workflows are
  solid. It should not distract from orchestration correctness, but it could
  turn benchmark progress, local model tuning, or community leaderboard activity
  into a playful retention/publicity surface later.

## Suggested Build Order

1. Stabilize graph editor interactions:
   - fix close control
   - prevent drag fallback to library
   - support dropping onto connector lines
   - make connector topology one split and one merge
2. Clean navigation:
   - remove Chat/Code toggle
   - remove Dispatch
   - rename current graph canvas as Orchestration
   - reserve Graph View for the log/context graph
3. Implement project-folder conversations:
   - click a folder such as Metis
   - show conversations/logs scoped to that repo path
4. Add preset save/load:
   - local files first
   - later marketplace import/export
5. Add Test Route:
   - run a sample prompt through the selected orchestration
   - show selected path and result
6. Build the real Graph View:
   - conversation nodes
   - project file nodes
   - memory note nodes
   - link traversal preview
7. Build Gallery:
   - import images
   - tag/classify references
   - connect Gallery as a frontend-design skill
8. Plan the unified marketplace:
   - skills
   - MCP connections
   - presets
   - full orchestration templates
9. Add provider/settings management:
   - editable environment variable fields
   - provider-level key reuse across models
   - subscription-backed API access without blocking BYO keys
10. Build the orchestration manager AI:
    - prompt box for graph edits
    - explain selected route
    - suggest specialists, fallbacks, and skills
    - connect decisions to Graph View logs and memory links
11. Add Benchmark section:
   - surface Metis Benchmark results
   - use results to explain route quality and hardware fit
12. Plan local cluster delegation:
     - discover owned machines
     - describe available local models
     - route private/local tasks across trusted hardware
13. Optional post-core engagement experiment:
    - idle-game style progression tied to benchmark/routing achievements
    - keep it opt-in and separate from serious benchmark results
    - use only after the product is already useful without it

## Hard Boundaries

- Metis Benchmark measures models and hardware.
- Metis Policy decides routes from evidence and preferences.
- Metis Orchestrator edits, visualizes, and executes orchestration.
- Do not hide route behavior behind uninspectable magic.
- Do not store raw prompts remotely by default.
