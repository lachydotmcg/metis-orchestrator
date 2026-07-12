# ▶ THE 48-HOUR DRILL PLAN (written 2026-07-10 by Fable, per Lachy)

> The master work queue for an autonomous 48-hour improvement run on Metis Orchestrator.
> The coordinator agent works this top to bottom on constant ticks, never stopping, never
> giving up. Every item traces to Lachy's feedback (L#) or the standing roadmap (Q#).
> Rules of engagement are at the bottom. Check items off in this file as they ship.

---

## ★ LACHY BATCH 2 (2026-07-11, live feedback mid-drill) — DO THESE NEXT, prioritized

Substrate already found (don't rebuild): `PermissionRequestCard` (App.tsx ~4563) already
renders Allow-once / Always-allow / Deny off `InRunPermissionRequest` + `PermissionVerdict`
(backend `promptForPermission` main.ts ~1502, ipc `metis-permissions:respond`).
`UserQuestionCard` (App.tsx ~4610) already renders ONE question with option chips + a custom
free-text field, off `UserQuestionRequest` + the `<ask_user>` parser (main.ts ~1454/1542/6285).
ManagerWidget (App.tsx ~11363) drags via its header when OPEN or MINIMIZED; the CLOSED
`manager-fab` (~11464) is a plain button and does NOT drag.

- [x] **B2.5 — Manager FAB draggable (Lachy: I STILL want to move the little widget).**
  RENDERER. The little closed-state launcher (`manager-fab`, App.tsx ~11464) is a fixed
  button with only onClick. Make it draggable: reuse `managerWidgetPos`/clamp, add a
  click-vs-drag threshold (a small movement = reposition, a clean click = open). ALSO
  re-audit the minimized-pill drag: check `-webkit-app-region` on the widget/FAB and their
  ancestors in styles.css — any OS-drag strip must not swallow pointer events on the
  draggable surfaces (this is the Electron bug L1 only half-fixed). NEEDS LIVE TEST in the
  Electron app (app-region is a no-op in the Vite preview).
- [x] **B2.3 — AI popup questions (up to 4) rising from the chatbox, with custom answers.**
  (a) BACKEND (main.ts + contracts, ADDITIVE/optional so the current single-question
  UserQuestionCard keeps compiling): extend so `<ask_user>` may carry MULTIPLE questions
  (cap 4), each with options + an allowCustom flag; add optional `questions?: {text,
  options, allowCustom?}[]` to UserQuestionRequest (keep `text`/`options` for the 1-question
  case). (b) RENDERER: a popup that rises from the chatbox showing up to 4 questions, option
  chips per question + a custom free-text answer each; collects all answers then resolves.
  STATUS: (a) BACKEND DONE — UserQuestionRequest gains optional questions[] (cap 4, each with
  options + allowCustom), extractAskUserTag parses both legacy + batched forms, answer round
  trip widened to UserQuestionAnswer = string | string[], prompt injection documents the
  batched tag. (b) RENDERER popup still to build (UserQuestionCard renders 1 question today).
- [x] **B2.4 — "Would you like to allow this action" as a real on-screen popup.** RENDERER.
  The PermissionRequestCard (Allow once / Always allow / Deny) already exists but renders
  INLINE in the chat. Elevate it to a prominent floating popup overlay (rising near the
  chatbox / centered), same three verdicts wired to the existing `metis-permissions:respond`.
  Keep the inline resolved-record behavior. Do B2.3 and B2.4 popups with a shared surface
  grammar so they feel like one system.
- [ ] **B2.2 — Benchmark Recommended-setup Model text is cut off.** RENDERER/CSS. In the
  Benchmark tab's Recommended setup card, the Model value text is clipped. Find the card and
  fix the overflow (wrap / min-width:0 / no fixed-width truncation) so the full model name shows.
- [ ] **B2.1 — Move vision model selection to the Gallery (Lachy: tbh).** RENDERER. The vision
  model picker currently lives in Settings; move (or also surface) it in the Gallery where
  vision/images are actually used. Confirm the picker stays honest (Auto-detect + local
  Ollama vision models only, as restricted earlier). Lower priority ("tbh") — do after the above.
- [x] **B2.7 — Router/managed-agent wrote to agent-memory instead of the attached workspace
  (2026-07-11 live bug, HIGH — correctness).** Lachy attached a workspace (metistest4) and ran
  a routed agent; it edited files under the app's conversation/agent-memory storage instead of
  the attached project folder. The run's file-write root resolved to the dataPath conversation
  store rather than the selected projectPath/workspace. BACKEND (main.ts): trace how projectPath
  flows from the selected workspace into the run's file operations (grep dataPath ~543,
  writeConversations ~4105, the stage file-write/apply path, and the routing/managed-agent path);
  find where projectPath is empty/overridden so writes fall back to a data dir, and make the
  agent write to the attached workspace. NEEDS a clear root-cause report + live test.
- [x] **B2.6 — Gallery image viewer cut off when you click an image.** RENDERER/CSS. Clicking an
  image in the Gallery opens a viewer/lightbox whose image is clipped (same overflow family as
  the earlier doc-view cutoff). Find the gallery image click handler + its viewer CSS and fix the
  overflow so the full image fits (max-width/height:100%, object-fit:contain, no fixed clip).

---

## ★ LACHY BATCH 3 (2026-07-11, accounts + onboarding) — DO AFTER BATCH 2

- [x] **B3.1 — Rename Pulse to Community app-wide.** RENDERER. The Pulse nav item / page title /
  any user-facing "Pulse" string becomes "Community". Grep App.tsx (and the sidebar order + any
  labels) for Pulse and rename the user-facing copy; keep internal keys stable unless trivial.
- [ ] **B3.2 — User profile + plan (replaces the hardcoded "Pro" badge).** Lachy wants real
  accounts: set your name, and a plan concept where BYO (bring-your-own keys) is the default,
  with paid subscription tiers as a FUTURE product decision (do NOT build payments now). (a)
  BACKEND (main.ts + contracts + preload): a UserProfile { name?, plan: "byo", modelPreference?:
  "local"|"cloud", createdAt, onboardedAt? } persisted in a profile store, with get/set ipc +
  preload bridge. Default plan "byo", no onboardedAt. (b) RENDERER: a profile UI to set your name,
  and replace the hardcoded "Pro" label next to the name (grep it in App.tsx) with the plan label
  (BYO). Keep it honest, local-first (this is a LOCAL profile, not server auth).
  STATUS: (a) BACKEND DONE — UserProfile/MetisPlan contracts, metis-store/profile.json store
  (readUserProfile/writeUserProfile, never throws, BYO default), metis-profile:get/set ipc,
  metisProfile preload + global.d.ts. (b) RENDERER (name UI + replace Pro badge) still to build.
- [ ] **B3.3 — First-run onboarding experience.** RENDERER (reuses Benchmark). On first launch
  (profile.onboardedAt absent), run a wizard: (1) welcome + set your name, (2) preference Local
  Models or Cloud, (3) hardware check + model recommendations (reuse the Benchmark's hardware
  detection + recommend flow), (4) install the picks (reuse the one-click / drag-drop Ollama
  install), (5) you are BYO by default (explain bring-your-own keys; offer to add one or skip).
  On finish set profile.onboardedAt + name + modelPreference, then land in the app. Do not seed
  fake data; if hardware detection is unavailable, degrade honestly.

---

## PHASE 0 — Bugs and quick wins (do these FIRST, they're what Lachy touches daily)

- [x] **L4 — Chat latency + snapshot-dump replies.** Typing "Test" in a new conversation
  thought for over a minute and replied with a project-structure summary ("The project
  snapshot shows a multi-directory structure..."). Two fixes: (a) a FAST PATH for short/
  trivial prompts — don't run the full route ceremony + snapshot summarisation for a
  2-word message; (b) the chat prompt must not instruct the model to describe the project
  snapshot unprompted — snapshot context should inform answers, not BE the answer. Find
  where projectSnapshot is injected into sessionProviderPrompt and make it conditional/
  toned down. Also investigate the 60s+ latency (likely a slow local model on the chat
  chain or the snapshot build) — instrument and fix.
- [x] **L5 — Stop button must stop INSTANTLY.** Today cancel checks `throwIfCancelled` at
  stage boundaries, so an in-flight model call runs to completion first. Thread an
  `AbortController` through every provider fetch (Ollama + cloud) keyed by the run scope;
  `metis-session:cancel` aborts the live fetch AND the stage loop. Verify a long local
  generation stops within ~1s.
- [x] **L1 — Collapsed Manager widget STILL not draggable** (regression or incomplete fix;
  the `-webkit-app-region: no-drag` fix shipped in 9048754 but Lachy still can't drag it
  when minimized). Re-diagnose properly: check `.manager-widget.minimized` pointer-events,
  header hit area (the title span may be tiny), whether the collapsed pill ends up under
  the OS titlebar drag strip when parked high, and whether pointer capture is being stolen
  by a child. Fix until a minimized widget drags reliably.
- [x] **L16 — Dead "side panel" box, top-left of Graph View.** Does nothing; there's already
  a collapse control. Find it and remove it.
- [x] **L18 — Conversation minimap (the "3 lines") shows on New Session** where it has no
  purpose. Hide it when there's no conversation content.
- [x] **L14 — New gallery boards get a "new" mood tag.** `createBoard` seeds `tags: ["new"]`.
  Remove the seeded tag (empty tags for a fresh board).
- [x] **L11 — Routines page:** the grey "+ New Routine" button in the middle empty state is
  ugly and redundant (there's a New Routine button top-right) — remove it, keep a plain
  empty-state sentence. Also RENAME the nav item and page title from "Routines / schedules"
  to just "Routines".
- [x] **L25 — Run Test panel is clipped into the sidebar and far too big.** Shrink to ~25%
  of current size (slim rows, compact type) and fix the clipping/positioning so it never
  overlaps the right rail.
- [x] **L7 — Message copy UX.** Normal prose replies must never render as a giant copy
  block. Add a small hover-only copy ICON (no text label) at the bottom of each assistant
  message; it appears on message hover only. Keep code-fence copy behaviour for actual code.
- [x] **L3 — Permissions button should be SMALL** — a compact pill like Claude Code's mode
  chip (see Lachy's screenshot: a tiny "Auto" pill bottom-left that opens Manual / Accept
  edits / Plan / Auto / Bypass permissions). Replace the current shield button + popover
  trigger with that compact pill showing the current mode name.
- [x] **L8 — Rename "Moodboards".** Lachy dislikes the name. Use "Boards" (palette group
  label + node sublabel "Board · loads first"). Keep it short and neutral.
- [x] **L26 — Sidebar order:** New session, Orchestration, Manager, Marketplace, then the
  More tab containing: Routines, To Do List, Gallery, Graph View, Benchmark. Exactly that.
- [x] **L2 — The composer "+" button should accept image files too.** Today + adds
  files/folders as workspace resources; when an image is picked it should become a chat
  attachment (same pathway as the ImagePlus button). Merge the flows: images → attachments,
  everything else → resources.
- [x] **L21 — Marketplace: permissions only on expand.** Package cards should NOT show
  permissions_requested chips in the grid; show them only in the expanded/detail view.
- [x] **L19 — Settings registry section is overloaded** ("a million things pasted in").
  Slim the General>Marketplace-registry panel to: source URL + refresh + a count line.
  The full package list moves to its own Settings section ("Registry") or just links to
  the Marketplace. No giant package dump inside General.
- [x] **L22 — Audit trail gets its own Settings section** (move it out of General; keep a
  small link from General).
- [x] **L20 — Uninstalling a package must revoke the scoped grants it requested.**
  installPackage calls requestPermission per scope; uninstallPackage must remove/revoke
  those grants (match by the package-note or store grant ids per package id).

## PHASE 1 — Models & gateways expansion (L10, L17) — RESEARCH ROUND

- [x] **L10 — Way more models + way more gateways.** Do real research (WebSearch, and
  Lachy's browser via the claude-in-chrome tools if needed):
  - GPT-5.6 is out with THREE variants — add all three to MODEL_LIBRARY + the registry
    catalog (best-effort ids, like the existing zoo).
  - **OpenRouter must be a first-class GATEWAY for basically every cloud model** — it's a
    provider today but not offered as a route on other models. Extend catalog/models.json
    access[] arrays so major models list an openrouter route, and make sure the node
    Gateway control offers it.
  - **NVIDIA NIM must be selectable as a gateway for DeepSeek** (Lachy literally can't
    pick it today — check the catalog access[] for deepseek models includes nvidia and
    that the picker/gateway UI surfaces it).
  - Add other gateways worth having: Groq (already a provider), Together AI, Fireworks,
    Cerebras, Mistral's API, xAI direct — pick what's real and wire route entries.
  - Update BOTH the in-app MODEL_LIBRARY/PRETTY names AND the metis-registry
    catalog/models.json (push the registry; Lachy granted bypass).
- [x] **L17 — MANY more local models, and role-aware Benchmark recommendations:**
  - Expand LOCAL_MODELS well beyond 7 entries: Qwen3 family, Llama 3.3, Gemma 3 (incl.
    vision), Phi-4, Mistral Small, DeepSeek-R1 distills at multiple sizes, Ornith, LLaVA,
    moondream, nomic-embed-text (as the embed model), etc., each with vram + ollamaTag.
  - Benchmark recommends BY ROLE: Router, Coding, Planning, **Vision (for Gallery)**, and
    Embeddings — with a role filter/tabs on the model table for your hardware.
  - Ask "do you plan to run local-first?" in the benchmark flow and weight recommendations
    accordingly.

## PHASE 2 — Gallery & vision pipeline (L9, L12b, L15)

- [x] **L9 — Gallery images must ACTUALLY inject into the API request.** The style-memory
  retrieval currently injects text (caption/palette) into the front-end stage. Now that
  multimodal attachments exist (3b4ee24), pass the retrieved reference image's actual
  bytes as an image input to vision-capable models on the front-end stage (reuse the
  SessionAttachment/ProviderImageInput plumbing; cap 1-2 reference images; text fallback
  for non-vision providers).
- [x] **L12b — Configurable VISION model in Orchestration.** A vision-model setting (which
  model captions gallery images and receives image inputs) editable from Orchestration
  (and/or Settings). Today detectOllamaVisionModel hardcodes discovery; make the choice
  explicit with auto-detect as default.
- [x] **L15 — Pinterest sync (if possible).** Investigate: Pinterest API requires OAuth
  apps; the pragmatic v1 is "Import from Pinterest board URL" — fetch the public board
  page/RSS, pull pin image URLs, import them as gallery images. If Pinterest blocks
  scraping hard, ship "paste image URLs / drag from browser" bulk import instead and
  document why. Best-effort, guarded.
- [ ] Gemma vision caption quality pass (Q: gallery captions still bland on some models —
  tune per-model, verify with the new prompt).

## PHASE 3 — Manager power-ups (L12, L6, M3)

- [ ] **L12 — Manager base-model picker + more purpose in the Manager tab.** Let Lachy set
  the Manager's model (chain head) from the Manager tab (a compact model picker in the
  chat header) and/or via an Orchestration "Manager" node. Persist to a store key the
  backend reads (managerChatChain consults it first).
- [x] **M3 — Manager ACTIONS (the big one).** The Manager can actually DO things, each
  routed through the permission ceremony (gatePermission / approval chips):
  - "Fire a prompt into project X" → dispatches a real session run into that folder.
  - "Add/assign todos" → writes the shared board.
  - "Change orchestration" → propose a graph edit (model/gateway/skill change) that the
    user approves before it applies.
  - Implementation sketch: teach metis-manager:chat a lightweight tool-call protocol
    (model returns a JSON action block; backend validates + surfaces an approval chip in
    the chat; on approve, execute and report). NEVER auto-execute without approval.
- [x] **L6 — More agentic tasks INSIDE conversations.** Extend the chat path with real
  in-conversation capabilities (each behind the permission model): read/list project
  files on request, write a file, run the verify step, create a todo, create a routine,
  and web-fetch a URL for context. Surface each as slim operation chips (the existing
  grammar). This is "the chat can act", not just the build pipeline.

## PHASE 4 — Marketplace, registry & MCP (L13, Q-preset, Q-MCP)

- [ ] **L13 — Seed MORE real skills + MCP connections.** Research https://github.com/mcp
  (the official MCP registry org) + modelcontextprotocol/servers + community lists; add
  a second seeding wave to metis-registry (10-20 more quality MCP servers with configs,
  more skills). Push the registry.
- [x] **Q — Preset install applies the orchestration.** Reconcile the preset payload format
  (publish wizard embeds {nodes}; seeded presets use {name,prerequisiteSkills,stages}) —
  pick ONE canonical schema ({nodes} + optional prerequisiteSkills is best), migrate the
  3 seeded presets, and make installing a preset: write payload → PRESET_STORAGE_KEY,
  auto-install prerequisite skills via metisRegistry, toast "Preset applied — open
  Orchestration".
- [x] **Q — MCP client wiring, phase 1.** Installed MCP packages: store the parsed mcp.json
  config, show servers in Settings>MCP with status, and implement SPAWN + tools/list over
  stdio for local npx servers (guarded, opt-in, permission-gated). Phase 2 (using MCP
  tools mid-pipeline) is a stretch goal — design it in FABLE_PLANS if not built.
- [x] Skill auto-install in onboarding (map recommended-preset prerequisite skills to
  registry ids now that both exist; one click installs models AND skills).

## PHASE 5 — Managed agents phase B (Traycer-informed; Lachy's north star)

- [x] **N-agent fan-out on one codebase.** Reference: traycer.ai (Lachy: "what I wanted
  already exists"). Build: task decomposition fans out to multiple named sub-agents
  (Nyx/Talos/Echo/Atlas/Juno identities exist), each claiming disjoint FILE TERRITORIES
  via a file-claim ledger on the directive bus; each agent renders as its own side-chat
  card (the §26 surface); agent-to-agent messages (question / review-request / handoff)
  travel the bus and render in the side-chats; a merge/verify step runs at the end.
  Spec-first: each fan-out writes a small task doc first. Differentiator vs Traycer:
  local-first = 10 agents for free.
  SUBSTRATE (already exists, build on it): `SessionDirective` (runtime-contracts ~515: the
  directive bus, scoped steering messages) and the `stage_call` stream event (~696: per-model-call
  side-chat cards) rendered by SideChatCard/SideChatStack; MANAGED_AGENT_IDENTITIES
  (Nyx/Talos/Echo/Atlas/Juno) already defined. DISPATCH-READY SUB-ROUNDS:
  5a (backend main.ts + contracts) = fan-out run mode: decompose a task into N sub-tasks, each
  assigned an agent identity + file TERRITORIES (path globs); a file-claim ledger (Map scope ->
  path -> agentId) rejects a second claim on the same path; each sub-agent runs as its own staged
  call emitting stage_call events tagged with an optional agentName; v1 may run sub-agents
  SEQUENTIALLY under the hood while presenting them as distinct agents; spec-first task doc per
  sub-agent; final merge/verify stage. 5b (backend) = agent-to-agent messaging: extend
  SessionDirective with kind (steer|question|review_request|handoff) + fromAgent/toAgent
  (Traycer's walkie-talkies). 5c (renderer) = fan-out visualisation: tag each side-chat card with
  its agent identity + hue, show the file-claim ledger, thread agent-to-agent messages. Do 5a
  first (the engine); keep each sub-round shippable and build-green on its own.
  STATUS: 5a shipped, 5c viz shipped, 5b backend shipped (kind + fromAgent/toAgent on
  SessionDirective, consumerAgent delivery filter, postAgentDirective helper) — NEEDS LIVE
  TEST for live inter-agent traffic; 5c thread-render of agent-to-agent messages is a follow-up.
- [x] **§20 leftovers** — grouped-chip grammar for retrieval + "Ran N agents" summaries
  (now that sub-agents exist).

## PHASE 6 — Reliability & scale

- [x] **§19 phase 2 — key POOLS.** Multiple keys/accounts per provider (ProviderAccount:
  provider, keyRef, label, cooldownUntil, usedToday), rotation across pooled accounts
  before falling to the next provider, per-account cooldowns (today they're per-provider),
  pool UI in Settings>Providers with per-account health. Backend engine e10daf6; pool UI
  (Add key, editable label, cooldown pill, usedToday, remove) shipped. REMAINING: per-account
  SECRET entry needs a desktop bridge (metisSecrets is single-key today) — UI shows an honest
  Key-not-linked state rather than faking storage. NEEDS LIVE TEST.
- [ ] **§16 phase 2 — Knowledge Banks.** Graph View as the bank front-end (chunks as
  openable nodes), conversation embedding (index past conversations, retrieve into chat),
  and per-bank selection. Builds on the shipped phase-1 embeddings.
  STATUS: conversation-indexing BACKEND shipped (buildOrLoadConversationIndex +
  retrieveConversationContext, ipc metis-knowledge:searchConversations, preload bridge) —
  NEEDS LIVE TEST vs a real nomic-embed-text Ollama. REMAINING (renderer follow-up):
  retrieve-into-chat surfacing, Graph View chunk nodes, per-bank selection.
- [ ] **Parallel sessions live test note** — needs Lachy's Electron app; keep the checklist
  in FABLE_PLANS and verify opportunistically if he runs the app during the drill.
- [ ] **Auto-update download** — wire electron-updater + electron-builder publish config
  (the check+badge shipped in beab4e0). Blocked on Lachy cutting a GitHub Release; prep
  the config so his first release Just Works.

## PHASE 7 — Product & business (L23, L24)

- [x] **L23 — The Metis Subscription plan.** A real monetisation design doc
  (docs/BUSINESS_PLAN.md): free tier (local-first is free forever — that's the hook),
  a Pro tier (suggested ~$10-15/mo: cloud routing convenience, pooled managed keys,
  priority registry features, sync), and a metered token wallet for people without their
  own keys (buy N million tokens at cost+margin; price against DeepSeek/Gemini/Claude
  blended rates with worked examples). Include: what we meter, how wallet debits map to
  provider costs, quota UX (the heatmap/telemetry already prices local savings), Stripe
  as the obvious rail, and how subscriptions DON'T break the local-first ethos (never
  paywall local). Competitive scan: Traycer, Cursor, OpenRouter credits. This is a
  DESIGN DOC — no payment code this run.
- [x] **L24 — A real README.** Rewrite README.md as actual documentation: what Metis is
  (the 3-layer story), feature tour (one section per surface), install/dev/build,
  architecture overview, the registry/marketplace + publishing guide, roadmap link.
  Leave clearly-marked placeholder blocks for Lachy's logo + screenshots
  (`<!-- LOGO HERE -->`, `<!-- SCREENSHOT: orchestration graph -->` etc.).

## PHASE 8 — Fable's own additions (keep drilling when the above is done)

- [ ] Wire the titlebar global search (currently disabled "coming soon"): search across
  conversations, project files, settings, marketplace — a Ctrl+K command palette.
- [x] Auto-title conversations (first-run summary → conversation title, replacing "New
  conversation").
- [x] Conversation export: copy-whole-chat as markdown + save-to-file (also fixes the
  Privacy>Export disabled state — build the real bridge). Bridge a417ad8, button 30be8f5.
  NEEDS LIVE TEST for the save dialog.
- [ ] Streaming Manager chat (SSE-style token streaming into the widget).
- [ ] Per-conversation token/cost line (reuse telemetry; show at conversation top).
- [ ] Prompt templates / snippets library in the composer (slash-command style).
- [ ] First-run tour: a 5-step overlay pointing at Orchestration, Manager, Marketplace,
  Gallery, Benchmark (ties into §17 onboarding).
- [x] Electron-builder packaging config + a GitHub Actions release workflow (so Lachy can
  cut releases by tagging). NOTE: run `npm i -D electron-builder` locally + commit the
  lockfile before CI `npm ci` will pass; see docs/RELEASING.md.
- [ ] Error/crash reporting surface (an in-app "last errors" view fed by the audit log).
- [ ] Routine templates ("Daily standup summary", "Nightly repo tidy", "Morning news
  brief" using Pulse).
- [ ] Sidebar keyboard navigation + shortcuts (1-9 to switch views).
- [ ] Proper font-size cascade for Appearance (replace body zoom with rem-based type
  scale).
- [ ] Composer autocomplete hint for /orchestration (and future slash commands): typing
  "/" shows a small command menu (orchestration, orch, + the prompt-template snippets).
- [ ] Graph View multi-folder browse: an ADDITIVE folder list (browse several folders'
  documents at once, not just the active project) — needs a small folder-listing IPC
  reusing the metis-files security guard.

---

## OPERATING PROTOCOL (non-negotiable)

1. **Cadence:** ScheduleWakeup every 45 minutes (2700s), forever, for the whole 48 hours.
   Each tick: check running/failed background agents → verify + commit + push finished
   work → dispatch the next round(s) → update this file's checkboxes → re-arm the wakeup.
   If a tick has nothing to verify, dispatch MORE work. Never end a tick without either a
   commit or a dispatched agent.
2. **Division of labour:** the coordinator (Fable) plans, diagnoses, verifies, commits.
   Sonnet subagents implement. EVERY subagent brief must include: "do all work yourself —
   the Agent tool is forbidden" AND "never git stash/checkout/restore/reset/rebase/commit/
   push". EXCEPTION: when Lachy has explicitly asked for direct work, or a change is small
   and surgical, the coordinator edits directly.
3. **Verification:** `npm run build` must exit 0 before EVERY commit (typecheck x2 + vite +
   electron). Use the `metis-renderer` preview (preview_eval / preview_inspect — screenshots
   time out) to verify renderer changes; bridge-dependent behaviour is code-reviewed +
   guarded instead. Never commit a broken build; if an agent dies mid-edit (API error),
   check git status + build, then RESUME the same agent via SendMessage.
4. **Git:** commit + push after every verified round. Commit messages QUOTE-FREE (PS 5.1
   mangles double quotes even inside here-strings). Repo: github.com/lachydotmcg/
   metis-orchestrator. Registry: github.com/lachydotmcg/metis-registry (bypass granted —
   push registry changes directly, but keep them reviewable and honest).
5. **One App.tsx writer at a time.** The renderer is one huge file — never run two agents
   that both edit App.tsx concurrently. Backend-only + registry + docs work can parallel.
6. **Research:** WebSearch/WebFetch freely for model/gateway/MCP research; Lachy's browser
   (claude-in-chrome tools) is available if a page needs a real session. Cite sources in
   commit messages where it matters.
7. **When blocked, skip and continue.** Nothing here blocks everything else. Log blockers
   in this file under a "Blocked" note with what's needed from Lachy.
8. **Memory:** update the metis-orchestrator memory file + the FABLE_PLANS POST-COMPACT
   HANDOFF header at least every ~6 hours of drilling so any future session can cold-start.
9. **Taste rules (Lachy's standing law):** slim neutral-greyscale + slate accent; dark text
   on accent fills; Claude-Code-style chat (prose + slim expandable operation rows, no
   boxes); no em dashes in user-facing copy; div-not-button backdrops (focus-ring bug);
   stable module-level store fallbacks (the [] literal trap); honest disabled states over
   fake buttons; never reintroduce the operations box; never seed fake demo data.
10. **Live-test handoffs:** things only Lachy can test (Electron app, Ollama, real keys)
    get a "NEEDS LIVE TEST" line in the commit + this file, never silently assumed working.

## STANDING ASKS FOR LACHY (surface these when he appears)
- Cut a GitHub Release (tag > 0.1.0) → lights the update badge + enables auto-update work.
- Real Discord invite for the Pulse tile (currently placeholder).
- Logo + app screenshots for the README when ready.
- Optional: relabel seeded registry publishers (anthropic/modelcontextprotocol → mirrors).
- Live tests: parallel sessions, knowledge-bank grounding (ollama pull nomic-embed-text),
  image attachments with a vision model, benchmark install progress, Manager chat replies.
