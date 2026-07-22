# Changelog

All notable changes to Metis Orchestrator are documented in this file.

This is the project's first tagged release. Everything below shipped during
active development leading up to it; there is no prior tagged version to
diff against, so this entry reads as a feature summary rather than a delta.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the app is put
together and [`docs/ORACLE.md`](docs/ORACLE.md) for the speculative-inference
engine referenced below.

## [Unreleased]

### Added (2026-07-21)

- **Loop spend ceiling.** `/loop --budget 200k` (CLI: `--budget`, alias
  `--tokens`) caps a loop's total token spend, summed from the usage
  ledger's per-loop attribution and checked before and after every turn.
  The loop settles as `exhausted` with both numbers in the reason.
- **Loops in the tray.** Sleeping and running loops are listed in the tray
  menu with status, turn count, budget, and a Stop item — with headless
  start or close-to-tray, this is the only surface a background loop has.
- **Per-node depths.** Each depths-enabled orchestration node's L1-L3
  stack now applies to that node's own pipeline stage, instead of one
  global table where a single node's stack won. The run's judged depth
  picks each stage's rung; the stage's normal chain stays the fallback.
- **/loop in the "/" popover.** The slash popover now offers /loop
  alongside /orchestration, /export, /summarize and /handoff.
- **Flowchart Loops, sequential v1.** `/loop --steps "read -> plan ->
  implement"` gives a loop an ordered step cycle with a wrapping program
  counter: each turn runs (and routes as) its current step, the panel
  shows step N of M, and the chain caps at 8 steps because it replays
  every turn. Parallel "&" steps are recognised and refused with a
  coming-later message, per the design doc. Three one-click loop
  starters also join the "/" popover.
- **Loop helpers (phase 2A).** A loop's "continue" decision can now ask
  for up to 3 parallel helpers, each a normal tracked run in its own
  conversation with the loop's frozen permissions and cancel scope,
  counted against the loop's token budget. A finished helper wakes the
  sleeping loop immediately; the timer becomes the fallback heartbeat.
  Helpers show as status chips on the loop's panel row.

### Changed (2026-07-21)

- **Suggestions are ghost text now.** Model-written follow-ups render as
  greyed-out text inside the prompt bar (Tab or click adopts them),
  replacing the chip row that used to sit above the composer.
- **The sidebar highlights the chat you're on,** not the project folder
  it lives under.
- **"Routed via" names the route actually taken** — your own graph-node
  label when the selected model matches one, else the provider and model.
  Never the router's internal task_type ("coding").

### Fixed (2026-07-21)

- **File-edit line counts are a real diff.** Every overwrite used to
  count the whole old file as removed and the whole new file as added, so
  a one-line tweak to a 189-line file displayed as "+189 -189". Counts
  now come from a prefix/suffix line diff (`shared/line-diff.ts`).
- **"Add todo" proposals no longer appear** while the To Do board is
  hidden from v1's navigation, and the chat prompt stops advertising the
  action kind entirely.

### Added (2026-07-17)

- **Per-model gateways.** Click a model in the orchestration Library to set
  its gateway and ordered fallback chain once, and that config now applies
  everywhere the model is used, instead of being set per node.
- **Depths.** Enable depths on a node and the router judges how hard each
  turn actually is, routing it to a lighter or heavier model per level.
  Level 3 defaults to the node's own model unless explicitly overridden.
- **Cloud Oracle via DeepSeek.** A separate, explicit opt-in lets Oracle
  draft/serve through DeepSeek using your own key when a DeepSeek model is
  pinned, clearly cost-labelled and off by default; local Oracle is
  unaffected either way.
- **Oracle draft streaming.** The Oracle popover's draft now streams in
  token-by-token as it generates, instead of appearing all at once.
- **Oracle v0.4 near-match serving.** An opt-in, off-by-default mode serves
  a draft when the sent prompt differs only cosmetically from the drafted
  one, gated by a lexical guard (vetoes on negations/numbers) plus a local
  embedding check on just the divergent part of the prompt. Served answers
  are labelled with an honest match percentage, never presented as
  identical to an exact-match serve.
- **Oracle prewarm on conversation open.** Opening a conversation now warms
  its remembered model immediately, before you type a single character.
- **Warm-chain for the build pipeline.** Starting a build stage now
  prewarms the next stage's model in the background, so stage-to-stage
  time-to-first-token drops across a run.
- **Usage tab in Settings.** Per-provider, per-model, and per-route (the
  actual gateway a call went through) token counts and cost estimates,
  pulled from real per-route pricing in the model catalog, with daily and
  weekly windows.
- **Usage limits and the 4-hour ring.** Set 4-hour, weekly, and wallet
  token limits in Settings > Usage, and see the rolling 4-hour window fill
  in a small ring next to the composer whenever Oracle is on. Display-only
  for now - nothing throttles yet, and the UI says so.
- **Learned-router preference log (Phase A).** Metis now keeps a private,
  local log of how you actually use it (which model answered, regenerates,
  model switches, task type), shown back to you in Settings > Usage as
  plain-sentence observations. Nothing changes routing yet; this is a
  record you can see, not a decision Metis is making for you.
- **Custom instructions.** A global custom-instructions field in
  Settings > Chat, applied to every prompt Metis assembles across chat and
  builds.
- **MCP, both directions.** Chat runs can now call the tools of MCP servers
  you have installed, behind an explicit opt-in toggle. Separately, Metis
  itself can be run as an MCP server (`scripts/metis-mcp.mjs`) so other MCP
  clients like Claude Code or Cursor can use Metis's own routing as a tool.
  See `docs/MCP_SERVER.md`.
- **Headless / service mode.** Start Metis hidden in the tray with no
  window, via a Settings toggle or the `--headless` flag, while the
  Gateway and routines keep running.
- **Global quick-ask.** A hotkey (Ctrl+Alt+M, off by default) summons a
  tiny always-on-top prompt bar anywhere in Windows, routed through Metis,
  with an open-in-app link on the answer.
- **Conversation forking.** Fork a conversation, optionally up to a
  specific turn, into a new conversation with its own copy of the turns -
  useful for trying a different model against the same context.
- **Routine dry-runs.** Preview what a routine would do before turning it
  on: it runs once under plan-only permissions into a fresh preview
  conversation, without touching the routine's schedule state.
- **Knowledge provenance.** The "grounded on N chunks" indicator on a chat
  turn now expands to list exactly which file and chunk grounded the
  answer, not just the count.
- **/handoff.** A built-in slash command that generates a compact
  continue-from-here brief (what happened, decisions, open threads) for
  moving a conversation to a fresh context or a different model.

### Fixed (2026-07-17)

- **OpenRouter routes no longer display as Grok.** Models reached via
  OpenRouter now show OpenRouter as the gateway/route, instead of being
  mislabelled as Grok (a display-only bug from OpenRouter having no
  dedicated brand entry; old persisted picks route correctly but display
  stale until reselected).

### Added

- **Metis Gateway.** A loopback-only (`127.0.0.1`), off-by-default
  OpenAI-compatible HTTP API (default port `11500`) so any OpenAI-client
  app, script, or tool can point its base URL at Metis instead of a cloud
  provider. `GET /v1/models` lists `metis-auto` plus installed Ollama
  models; `POST /v1/chat/completions` routes `metis-auto` through the exact
  same Auto Router decision the chat composer uses, or calls a pinned model
  directly, with streaming (SSE) support. Every request requires a
  per-install bearer token; one audit line per request records only the
  model id, timing, and ok/error, never the prompt content.
- **Per-conversation model memory.** Switching conversations now restores
  the model (pinned or preset) that conversation was last using, instead of
  sharing one global composer selection.
- **Prompt templates and a slash-command popover in the composer.** Save
  prompts you type over and over as named snippets and pick them from a `/`
  popover instead of retyping.
- **Streaming Manager chat.** The Manager assistant's replies now stream
  token-by-token into the widget instead of arriving all at once.
- **Speculative pre-routing.** While typing on Auto Router, Oracle now runs
  the route decision ahead of send so the chosen model can be prewarmed
  before you hit send, taking routing latency out of the critical path.
- **New Settings toggles.** Close-to-tray is now an explicit, off-by-default
  toggle in Settings > General, instead of implicit tray behavior on window
  close.
- **Model picker latency dots.** Each model in the picker now shows a
  fast/medium/slow dot from its recent measured time-to-first-token on this
  machine.
- **Owner-name greeting.** The home screen now greets you by the name set
  in your profile instead of generic copy.

## [1.0.0] - 2026-07-12

### Added

- **Metis Oracle**, a speculative inference engine for pinned local Ollama
  chat. It prewarms the model as you type (invisible prefill), drafts a
  full speculative answer during natural typing pauses (shown dimmed as
  "Oracle's guess"), and, when your prompt at send time exactly matches the
  drafted one, serves the finished answer instantly instead of calling the
  model again. Real-world testing measured **4.1x to 9.5x** faster
  time-to-first-token. Off by default, local-only (never sends prompt
  fragments to a cloud provider), one toggle in Settings > Experiments to
  try it. An Oracle activity chip near the composer shows warm/draft events
  and lets you watch it work.
- **The orchestration graph and router policy.** A visual pipeline builder
  with router, agent, and skill nodes; each node gets its own model,
  gateway, and fallback chain, editable right in the UI. The router policy
  applies per-task rules for quality, cost, and quota so easy work lands on
  a cheap or local model and hard prompts escalate to the cloud only when
  needed. Policies can be saved as presets, shared, or dry-run with a quick
  Run Test without a full build.
- **The build pipeline.** Runs go Plan, then Frontend, then Functional,
  writing real files into your project folder, verifying themselves, and
  self-repairing when something is off. Builds edit an existing folder in
  place instead of clobbering it. Every model call gets its own visible
  side-chat so you can watch what each stage said.
- **Managed-agent fan-out.** Large build tasks decompose into named
  sub-agents (Nyx, Talos, Echo, Atlas, Juno) that each claim disjoint file
  territories and run in parallel, similar in spirit to Traycer but
  local-first, so running many agents at once costs nothing. Agents talk to
  each other over a shared agent-to-agent bus (steering, questions, review
  requests, handoffs), rendered as their own side-chat cards, with a
  merge/verify step at the end. Behind an opt-in flag; a fan-out failure
  falls back to the single pipeline automatically.
- **Permission modes and popups.** Compact permission-mode pill (Manual,
  Accept edits, Plan, Auto, Bypass permissions) replaces the old shield
  button. Action approval ("would you like to allow this") now rises as a
  prominent on-screen popup with Allow once / Always allow / Deny, wired to
  the same permission system as the inline record.
- **Multi-question ask_user popups.** In-run questions from the model can
  now carry up to 4 questions at once, each with option chips and an
  optional custom free-text answer, collected in a single popup that rises
  from the chatbox.
- **The Manager**, a built-in assistant that knows your projects and
  to-dos, can hold conversations on your behalf, turn loose ideas into
  tasks, and tick off to-do items as they land. It can also take real
  actions (fire a prompt into a project, add/assign todos, propose an
  orchestration change) gated behind the same approval-chip ceremony as
  everything else, never auto-executed. It rides along as a floating widget
  you can drag anywhere on screen, including while minimized.
- **First-run onboarding and profile.** A wizard on first launch: set your
  name, choose Local, Cloud, or Hybrid model preference, run a hardware
  check with model recommendations (reusing Benchmark's detection), install
  the picks with one click, and land in the app on a real local `UserProfile`
  (name, plan) where BYO (bring-your-own API keys) is the default plan.
  Enter advances each step.
- **Marketplace and registry.** Browse, install, star, and publish skills,
  MCP connections, and orchestration presets, all reviewed and merged by
  pull request against the separate `metis-registry` repo. Installing a
  package is drag-and-drop; a Publish wizard generates the manifest and
  opens a pre-filled GitHub PR. Installing a preset now applies its
  orchestration and auto-installs any prerequisite skills. Basic MCP client
  wiring: installed MCP packages show live status in Settings > MCP, with
  spawn + tools/list over stdio for local npx servers, permission-gated.
- **Knowledge Banks.** Local embeddings over a project's files ground the
  pipeline's prompts in what's actually in the folder. Conversation
  embedding now also indexes past conversations so relevant history can be
  retrieved into chat, not just the current thread.
- **Metis Gallery**, a style-memory board: drop in reference images and
  Metis captions and sorts them automatically using local vision models. At
  build time the pipeline retrieves the right reference image (actual
  image bytes, not just a text caption) for vision-capable models on the
  front-end stage, so a build can inherit a real chosen look. Includes
  best-effort Pinterest board import.
- **Model presets.** Named shortcuts onto a model or route (e.g. "Coding"
  -> a specific model, "Default" -> Auto Router) selectable and deletable
  from the model picker, backed by a dedicated presets store.
- **Installed-model badges in the model picker.** Local models the user has
  actually pulled (cross-referenced against Ollama's own model list) are
  marked distinctly from ones merely available to install.
- **Ctrl+K command palette.** Search across conversations, project files,
  settings, and the marketplace, and jump straight to any nav view.
- **System tray.** A native tray icon with routing status, pause/resume for
  routines, recent runs, and close-to-tray vs quit.
- **Per-conversation token usage line**, shown at the top of a conversation,
  reusing the existing telemetry.
- **Errors panel.** An in-app "last errors" view fed by the audit log, for
  surfacing crashes/failures without digging through logs.
- **Provider key pools.** Multiple keys/accounts per provider with rotation
  across pooled accounts and per-account cooldowns before falling back to
  the next provider ("Never Run Dry"), managed from Settings > Providers.
- **Release pipeline and app icon.** Electron-builder packaging config plus
  a GitHub Actions release workflow so tagging a release builds installers;
  a real app icon replaces the placeholder.
- Conversation export (copy-as-markdown and save-to-file) and auto-titled
  conversations from a first-run summary.
- Vision-model selection surfaced in the Gallery (in addition to Settings),
  with auto-detect as the default.
- Model-driven routing (an opt-in flag): a lightweight local classifier can
  decide chat vs. build vs. edit instead of relying solely on regex intent
  heuristics; a pinned model still bypasses the classifier entirely.

### Changed

- **Pulse renamed to Community** across the app: the nav item, page title,
  and all user-facing copy.
- **Removed the redundant "save as preset" control from the model picker.**
  Presets are for named shortcuts (e.g. Coding -> Opus, Default -> Auto),
  and the inline save option read as redundant when it just mirrored the
  picked model.
- Onboarding's model-preference step gained a third option, Hybrid, next to
  Local and Cloud.
- The hardcoded account email shown in the account menu was replaced with
  the user's profile name.

### Fixed

- **Attached folder is now the writable project (PF1).** Attaching a
  project folder previously only registered it as a read-only resource;
  without an explicit writable workspace, builds silently fell back to the
  app's internal `generated-projects` storage instead of the folder the
  user pointed at. The folder you attach is now established as the
  writable workspace builds write into; additional folders can still be
  added as read-only references.
- **Advisory/explanatory prompts route to chat, not a build (PF2).** A
  "walk me through / explain this" prompt was being classified as a build
  request and tried to write files. Q&A-style prompts now stay on the chat
  fast-lane; only genuine build/change requests enter the pipeline.
- **Pinned model runs with no orchestration and no ceremony (PF3, PF5).** A
  pinned (non-Auto-Router) model previously still triggered the full build
  pipeline and printed routing ceremony ("Calling X directly", "Skipping
  the router", pipeline step names) even for a plain chat turn. A pinned
  model is now a direct, silent call to that model with no file writes and
  no route/step chatter, other than a slim "first token in Xms" line. Only
  an explicit `/orchestration` command still runs the pipeline on a pinned
  model.
- **Pinned model tag resolution (PF4).** Pretty model names (e.g. "Qwen3
  8B") now resolve correctly to their real Ollama tag (e.g. `qwen3:8b`)
  instead of failing to match an installed model.
- **Router/managed-agent writes landed in agent-memory instead of the
  attached workspace (B2.7).** A routed run against an attached project
  folder was resolving its file-write root to the app's internal
  conversation storage rather than the selected project path; agent writes
  now land in the attached workspace.
- **Text-cutoff fixes across the UI:** the Benchmark tab's Recommended
  setup card no longer clips the model name; the Gallery's image
  viewer/lightbox no longer clips the opened image.
- **Minimized/closed Manager widget now drags reliably**, including the
  closed-state launcher button, with a click-vs-drag threshold so a clean
  click still opens it.
- **Cancel now stops generation near-instantly** instead of waiting for the
  in-flight model call to finish, by threading an abort controller through
  every provider fetch.
- **A send no longer queues behind an in-flight Oracle draft** (previously
  measured at 13390ms of added latency): a newer prompt now aborts and
  replaces a stale in-flight speculative warm/draft.
- **Uninstalling a marketplace package now revokes the permission grants**
  it requested, instead of leaving them dangling.
- A misleading "Ollama is not reachable" message (which could show even
  when a model just wasn't pulled) was replaced with an actionable error
  naming the model and the fix (start Ollama, `ollama pull <model>`).
