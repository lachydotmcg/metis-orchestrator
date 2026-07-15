# ▶ THE 48-HOUR DRILL PLAN (written 2026-07-10 by Fable, per Lachy)

> The master work queue for an autonomous 48-hour improvement run on Metis Orchestrator.
> The coordinator agent works this top to bottom on constant ticks, never stopping, never
> giving up. Every item traces to Lachy's feedback (L#) or the standing roadmap (Q#).
> Rules of engagement are at the bottom. Check items off in this file as they ship.

---

## ★ PRIORITY FIX (2026-07-12, Lachy #1) — attached folder must be the writable project

Root cause: Metis has TWO folder concepts — project RESOURCES (filesystem.read, addWorkspaceResource,
stored under projectResources, for context/memory/Graph View) and the project WORKSPACE
(filesystem.write, selectProjectWorkspace, stored under projectWorkspace, the SINGLE folder builds
write into). When the user attaches a folder as a resource, no writable workspace is set, so
resolveWritableProjectWorkspace() (main.ts ~1799) returns null and writeProjectFiles() (~5322/5323)
silently falls back to dataPath("generated-projects") = the app-data area Lachy calls "agent-memory".
The B2.7 fix only patched the Manager-action path, not this (the real upstream cause).

- [x] **PF1 — Unify: the folder you attach IS the writable project (Lachy chose unify).** BACKEND
  (main.ts): when the user attaches a project folder, establish it as the writable workspace (request
  filesystem.write / project-tools + set the projectWorkspace store) so builds write THERE. Additional
  read-only reference folders may still be added separately. Builds must NEVER silently write to
  generated-projects when a folder is attached; only use the app-managed folder when truly nothing is
  attached (and surface that clearly). RENDERER follow-up: UI clearly shows "your writable project"
  vs read-only reference folders. NEEDS LIVE TEST: attach a folder, run a build, files land there.
- [x] **PF2 — Routing: thinking questions must be ANSWERED, not built.** BACKEND (router). A
  "walk me through / explain / give me a skeleton" prompt was routed to Build/edit-existing and tried
  to write files. The router should classify explanatory/Q&A prompts as CHAT answers (chat fast-lane),
  not file-writing builds. Also unblocks Oracle (prewarm only speeds the chat path). Tune the route
  decision so Q&A stays in chat; only genuine build/change requests go to the pipeline.
- [x] **PF3 — Pinned model = NO orchestration (Lachy: "if the model is not on Auto Router, there
  should be NO orchestration").** A pinned model still ran the full build pipeline on an advisory
  prompt. FIXED (main.ts): the build-pipeline gate (~7151) and the chat-path project-tools gate
  (includeProjectTools ~7463) now require `!input.modelOverride`, so a pinned model is a pure direct
  chat with no orchestration and no file creation. Only an explicit /orchestration command
  (forceBuildPipeline) still runs the pipeline with a pinned model. This makes PF2's regex routing
  moot whenever a model is pinned (it only matters on Auto Router). NEEDS LIVE TEST.

---

## ★ LACHY BATCH 6 (2026-07-12, pinned-chat silence + Oracle preview) — DRILL HARD

- [x] **PF5 — Pinned chat: ZERO ceremony (Lachy: "just dont show that man just fucking call the
  model").** His pinned run showed: "Calling Qwen Qwen3 8B directly. Skipping the router." +
  "Called Qwen Qwen3 8B directly" + steps "Run Front End Orchestration Pipeline / Call selected
  model / Write response and audit trace". ALL of it must go for pinned chat. (a) BACKEND: when
  input.modelOverride is set on the CHAT path, emit NO route/direct-call timeline lines and use a
  neutral minimal step framing (no Front End Orchestration Pipeline naming - that leaked from the
  route decision task_type which is IRRELEVANT when pinned); keep the audit trail internally. Also
  fix the doubled label: overrideDisplayLabel = providerLabel + model gives "Qwen Qwen3 8B" - use
  the model name alone when it already carries the brand. (b) RENDERER: for pinned runs hide the
  route/Called-directly line entirely; KEEP "first token Xms" (Lachy engaged with it) as the only
  slim run metadata. Old routed runs unchanged.
- [x] **O2 — Oracle v0.2: show the precognition (Lachy: "I do want to see a preview of what the
  ai is thinking... for now atleast").** (a) BACKEND: metis-prewarm:draft(model, draft) -> { text }
  - same guards as warm (flag, local-only, dedupe, in-flight, fail-soft) but generates a SHORT
  speculative draft (num_predict ~96-128, keep_alive 5m) and RETURNS the text instead of
  discarding. Never a conversation record, never files. (b) RENDERER: in the Oracle chip popover,
  show the latest draft DIMMED as "Oracle's guess" (clearly speculative, updates as you pause
  typing, harder debounce ~800ms so it fires on real pauses); never auto-inserted into the chat.
  v0.3 LATER (Lachy's confidence idea): on submit, if the draft's prompt matches the final prompt
  closely, stream the draft instantly while the real call confirms - needs a confidence/match
  gate; design after v0.2 lands.

---

## ★ O4 — Oracle v0.3: serve the precognition (SHIPPED 2026-07-12, Fable direct)

- [x] **O4 - confidence-gated instant serving (Lachy: if nothing changed, it's ready to go).**
  O3 measured 365ms (from 1285ms). v0.3 closes the loop: draftModel now generates with the SAME
  default sampling as the real call (no temperature override), num_predict 768 as a runaway cap,
  and only a draft that finished naturally (done_reason stop) from an ASSEMBLED prompt is cached
  as servable (model + sha256 of the exact prompt string, 3min TTL, one-shot claim). In runSession
  pinned chat, before invoking the provider: pinned + local Ollama + no images + prewarmEnabled +
  EXACT hash match -> the draft is served instantly (thought_delta + message_delta emitted, real
  audit line, providerResult built with measured serve ms), run.oracleServed = true, renderer
  shows Oracle answered instantly, Xms. Any mismatch falls back to the normal call (which still
  gets the O3 warmed prefix). Exact-match only by design: near-miss similarity serving is a
  possible v0.4, needs a real confidence metric. NEEDS LIVE TEST: type, pause until the guess
  lands, send unchanged -> instant.

---

- [x] **O4.1 - sends never queue behind speculation (Lachy measured 13390ms).** The v0.3 draft is a heavyweight job (2048 tokens + thinking) and Ollama serializes per-model requests, so a send during an in-flight draft queued behind it. Fixed Fable-direct (4c155cf): abortOracleSpeculativeWork aborts ALL in-flight warms + drafts at the top of the chat invoke path; a newer prompt ABORTS and replaces a stale in-flight draft (latest wins); cap 768 -> 2048 so thinking models finish naturally (done_reason stop) and become servable.
- [ ] **O5 - cloud Oracle (Lachy consents: happy to test via DeepSeek V4 Flash).** Draft/warm via a cloud provider with his own key, behind a SEPARATE explicit opt-in toggle (costs tokens, sends partial prompts to that provider, never silently). DeepSeek has automatic context caching, the natural first target. Harder debounce, no per-keystroke spend, clear cost copy. Fable-direct per the Oracle rule.

---

## ★ LACHY BATCH 11 (2026-07-15, depths + gateway fix)

- [ ] **B11.1 - Correct gateways per model/provider in the Orchestration UI.** Lachy: DeepSeek
  still only shows DeepSeek as its api/gateway option in the node Gateway control. The registry
  catalog's access[] routes already model multi-gateway (e.g. DeepSeek via deepseek native,
  OpenRouter, NVIDIA NIM) - the Orchestration UI's gateway picker must list every route the
  catalog declares for that model's provider, not just the home provider. RENDERER (gateway
  dropdown population from catalog access routes) + verify expandStageRef honors them.
- [ ] **B11.2 - DEPTHS node UI (Lachy speced).** Inside each orchestration model NODE: a checkbox to ENABLE depths + one brief sentence explaining it, then a STACK of the three levels rendered top-to-bottom L3 -> L2 -> L1 in the library UI when the node is clicked, each level row clickable to choose a different model for that depth (writes depthRoutes / per-node overrides). Plus a Settings toggle for depthRoutingEnabled and a slim depth chip on runs. NOTE the judgement direction shipped: depth is now the ROUTER MODEL S own call (classifyRouteWithModel returns depth 1-3, preferred over the keyword fallback); the future ideal per Lachy is the small model handling depth-1 turns itself.

## ★ PITCH BATCH 10 (2026-07-13, research round - AWAITING LACHY GREEN LIGHT, ranked by Fable)

- [x] **P10.1 - Metis Gateway (top pick).** Expose the router + Oracle as a localhost
  OpenAI-compatible API. Any app that can talk to OpenAI (Cursor, scripts, other tools) points
  at Metis instead and silently gets quality/cost/quota routing + prewarming. Metis becomes
  infrastructure, not just an app. Trend-proof: LocalAI-style universal endpoints are the moat
  move in the space.
- [ ] **P10.2 - MCP tools used IN the pipeline.** We install and probe MCP servers but stages
  never call their tools mid-run. Wiring tool calls into stages makes the marketplace real and
  matches the ecosystem standard (everything speaks MCP now).
- [x] **P10.3 - Living-spec fan-out.** The coordinator writes a spec doc as a first-class
  artifact; parallel agents update their sections live and you watch it evolve. We already have
  the fan-out engine, file-claim ledger and agent bus - this is the missing visible artifact.
- [ ] **P10.4 - Oracle for code.** Speculative edit-drafting inside the build pipeline (draft
  the frontend stage while plan streams). Market-validated: codegen-tuned speculative decoding
  is a headline feature elsewhere (Morph).
- [ ] **P10.5 - Headless / service mode.** Start minimized to tray, no window, serving the
  Gateway. Completes the tray + pairs with P10.1.
- [ ] **P10.6 - Hybrid per-stage thoroughness.** Local drafts + cloud verify passes as a dial -
  this IS the parked B7.2 thoroughness meter; the market converging on it argues for un-parking.

---

## ★ IDEA BATCH 9 (2026-07-13, Fable research round - Lachy: free reign, come up with new ideas)

Grounded in the existing substrate; each names what it builds on.

- [ ] **I9.1 - Oracle Everywhere: prewarm on conversation OPEN.** The moment you open a
  conversation (before typing at all), prewarm the assembled prefix (system + context +
  snapshot) for that conversation's remembered model (B7.1 map makes the target knowable).
  First keystroke then starts from a warm prefix instead of a cold one. Builds on
  assembleChatPrewarmPrompt + conversationModels.
- [ ] **I9.2 - Oracle draft STREAMING into the popover.** The guess currently appears all at
  once (draftModel is stream:false). Stream it so the popover shows the guess forming live -
  the demo becomes hypnotic and Lachy sees thinking in real time. Small: reuse
  invokeOllamaProviderStream shape inside draftModel behind the same guards.
- [ ] **I9.3 - Warm-chain for the build pipeline.** While the PLAN stage streams, prewarm the
  FRONTEND stage's model with its (partially known) prompt prefix; while frontend streams,
  prewarm functional. Stage-to-stage TTFT drops across the whole pipeline. Builds on
  prewarmModel + the stage chain in runOrchestratedStages.
- [ ] **I9.4 - Routine dry-run + preview.** Before enabling a routine, run it once in plan-only
  permission mode and show what it WOULD have done (files, calls). Reuses permissionMode plan +
  the existing routine runner. Trust-builder for scheduled automation.
- [ ] **I9.5 - Conversation forking.** Fork a conversation at any turn into a new conversation
  (copy turns up to that point). Cheap in the store model (ConversationRecord.turns slice) and
  pairs beautifully with per-conversation models: fork the same context onto a different model
  and compare.
- [ ] **I9.6 - A/B answer mode.** Ask once, two models answer side by side (local vs cloud, or
  two locals), pick the winner; the pick is recorded as a preference signal (future: feeds the
  router policy). Builds on the side-chat surface + invokeProvider.
- [ ] **I9.7 - Knowledge Banks auto-context chip.** When retrieval grounds a chat turn, show a
  slim expandable chip listing WHICH chunks (file + line-ish) grounded it - the §16 renderer
  follow-up shaped as a trust feature (provenance, not just retrieval).
- [x] **I9.8 - Model health strip on the picker.** The picker already badges installed; add a
  tiny latency dot from recent ttftMs telemetry per model (green under 500ms, amber under 2s)
  so picking a model shows how it has actually been performing on THIS machine. Builds on
  SessionRun.ttftMs history.
- [x] **I9.9 - /export and /summarize slash commands.** The template popover already owns the
  slash surface; add built-ins: /export (existing conversation exportMarkdown) and /summarize
  (local-model summary of the conversation appended as an assistant turn, clearly labeled).
- [ ] **I9.10 - Session handoff card.** One click generates a compact continue-from-here brief
  (project, decisions, open threads) as markdown - for moving a conversation to a fresh context
  or another model. Local-model generated, uses recentConversationContext.

---

## ★ LACHY BATCH 8 (2026-07-12, Oracle everywhere + branding)

- [x] **B8.1 - Metis Oracle joins the stack in the README** (done directly). Metis Gallery is
  HELD BACK from the stack until the Gallery gets more work (Lachy: hold off until we have
  worked on it more; future: more specific per-image descriptions).
- [ ] **B8.2 - O5 EXPANDED: Oracle for ALL cloud models + speculative pre-routing.** Lachy: use
  Oracle for any and all cloud models, and it could even plan WHERE TO ROUTE before you send.
  (a) Cloud prewarm/draft behind an explicit paid opt-in (DeepSeek first, automatic context
  caching; Anthropic prompt caching next; honest cost copy, hard debounce). (b) SPECULATIVE
  ROUTING: while typing on Auto Router, Oracle runs the route decision (decidePolicy +
  overrides) on the draft so the route is already chosen at send - zero routing latency - and
  can prewarm the CHOSEN target. Fable-direct per the Oracle rule.
- [ ] **B8.3 - Future: split Metis Oracle (and later Metis Gallery) into their own repos and
  open-source the specific technologies.** Oracle = the prewarm/draft/serve engine as a
  standalone lib; Gallery = the style-memory concept once matured. Not yet scheduled.
- [x] **B8.4 - Removed model-preset SAVE from the picker (Lachy: just do it).** Lachy: why is Save Qwen3 8B as preset an option?
  Its literally just a model. The affordance is for NAMED shortcuts (Coding -> Opus, Default ->
  Auto) and future route-configs, but the inline copy reads redundant when it just mirrors the
  picked model. Polish: subdue the control (e.g. a small Save current selection... link at the
  bottom of the Presets group only, clearer copy, maybe hide when a preset already matches).

---

## ★ LACHY BATCH 7 (2026-07-12, parked notes - Lachy: note down and forget for now)

- [x] **B7.1 - Per-conversation model selection.** The pinned model / preset choice should be
  remembered PER CONVERSATION (switching conversations restores that conversation's model), not a
  single global composer state.
- [ ] **B7.2 - Thoroughness meter.** A configurable refinement dial: how many times a response is
  fact-checked/refined by other models before it lands (0 = raw, N = cross-checked passes). Also
  detect INCOMPLETE outputs (Lachy hit a case where a task silently did not complete) and auto-retry
  or flag them - completion verification should be part of the same dial.

---

## ★ LACHY BATCH 5 (2026-07-12, model picker + router intelligence)

- [x] **B5.2 — Highlight INSTALLED models in the model picker.** RENDERER. The picker lists many
  models (great for discovery) but does not show which the user actually has installed, so Lachy
  picked qwen3:4b he had not pulled. Cross-reference the Ollama /api/tags list (already fetched via
  metisOllama) and mark installed local models (badge / sort installed first / de-emphasize
  not-installed with a one-click pull). Honest: only local models have an install state.
- [x] **B5.3 — Pinned model = direct call, no routing ceremony + clear Ollama-down error.** When a
  specific model is pinned, do NOT show "Routed via X" or run route ceremony — present it as a
  direct call to that model (main.ts ~7157-7166 already bypasses the router for the primary attempt;
  fix the LANGUAGE + skip unneeded ceremony). And replace the misleading "Ollama is not reachable
  yet, so Metis recorded the route without running the model" (main.ts ~1008) + "no live model
  answer was returned" (~4213) with a clear, actionable error: Ollama is not running or the model is
  not pulled — start Ollama and run ollama pull <model>, then retry.
  STATUS: BACKEND DONE — actionable Ollama-down message (with the model tag; the placeholder was
  leaking into run.warnings) + all backend pinned wording now reads as a direct call (incl. an
  unlisted initialPipelineSteps route-step gap). RENDERER follow-up: the literal "Routed via {label}"
  text in App.tsx (~4989/5475/5500/5529) must say "Calling X directly" when a model is pinned.
- [x] **B5.1 — Model/route PRESETS.** Instead of only "Auto Router", let the user save a named
  preset (a model or a route config), select it in place of Auto Router, and overwrite existing
  presets or save new ones. Renderer picker + a presets store.
- [x] **B5.5 — Oracle visibility (Lachy: "add a demo thinking tab to actually show that its
  working").** RENDERER. Oracle's prewarm is deliberately invisible, so testing feels inconclusive.
  Make it visible: (a) a slim Oracle activity chip near the composer that lights up when a warm
  fires ("Oracle: warming <model>" -> "warm, XXXms", renderer times the invoke round-trip),
  expandable to the last few warm events; only rendered when prewarmEnabled is on; (b) surface
  SessionRun.ttftMs on completed chat runs ("first token in XXXms") so warm-vs-cold is measurable
  in the UI, not just the audit log. Slim greyscale, honest (no fake pulses when nothing fired).
- [x] **B5.4 — DIRECTION: model-driven routing (Lachy: "its the models decision whether to route
  or not").** Today routing (chat vs build vs edit) is brittle regex heuristics (isBuildQuestionGuard
  / isEditIntent / hasImperativeBuildIntent — the ones PF2 just patched). Lachy wants a MODEL to make
  the call. Proposed: a fast intent-classifier call (cheap/local model) reads the prompt + context
  (project attached? recent turns?) and returns {mode: chat|build|edit, model?}. Pinned model -> no
  classifier at all (direct). Fast-path obvious cases to avoid the extra call. Behind a flag /
  experiment like Oracle; ties to Oracle (classify + prewarm speculatively as you type). NEEDS Lachy
  sign-off on approach before building.

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
- [x] **B2.2 — Benchmark Recommended-setup Model text is cut off.** RENDERER/CSS. In the
  Benchmark tab's Recommended setup card, the Model value text is clipped. Find the card and
  fix the overflow (wrap / min-width:0 / no fixed-width truncation) so the full model name shows.
- [x] **B2.1 — Move vision model selection to the Gallery (Lachy: tbh).** RENDERER. The vision
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
- [x] **B3.2 — User profile + plan (replaces the hardcoded "Pro" badge).** Lachy wants real
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
- [x] **B3.3 — First-run onboarding experience.** RENDERER (reuses Benchmark). On first launch
  (profile.onboardedAt absent), run a wizard: (1) welcome + set your name, (2) preference Local
  Models or Cloud, (3) hardware check + model recommendations (reuse the Benchmark's hardware
  detection + recommend flow), (4) install the picks (reuse the one-click / drag-drop Ollama
  install), (5) you are BYO by default (explain bring-your-own keys; offer to add one or skip).
  On finish set profile.onboardedAt + name + modelPreference, then land in the app. Do not seed
  fake data; if hardware detection is unavailable, degrade honestly.

---

## ★ EXPERIMENTS (Lachy-approved R&D, behind flags, off by default)

- [ ] **E1 — ORACLE (speculative prompt prewarm, faster responses).** Named by Lachy: Oracle, it
  sees your answer coming. Lachy's idea: as you type, feed the
  in-progress prompt to the LOCAL model so its response is prepared/prefilled, dropping
  time-to-first-token on submit. v0.1 = invisible PREFILL PREWARM only (no speculative answer
  shown, no file effects), LOCAL (Ollama) ONLY, behind a flag default OFF (like fanoutEnabled).
  (a) BACKEND (main.ts + contracts + preload + global.d.ts): prewarmModel(model, draft) hits
  Ollama keep_alive + prefill (num_predict ~0/1, no visible output, creates NO conversation
  record, NO run, NO stage events, NO file writes); server-side debounce/dedupe so keystrokes do
  not spam Ollama; fail-soft no-op if Ollama down; NEVER send partial prompts to any cloud
  provider (cost + privacy); a prewarmEnabled flag in settings; instrument TTFT so we can compare
  warm vs cold using the existing L4 timing audits. (b) RENDERER (follow-up): debounced call from
  the composer (~400ms pause) when the flag is on AND the target is a local model, plus a
  Settings experiments toggle. v0.2 later (only if v0.1 shows a real TTFT win): speculative DRAFT
  generation shown dim + instantly confirmed on match. Measure before expanding.
  STATUS: Oracle v0.1 SHIPPED — backend prewarm engine (8c2e31b), renderer composer debounce +
  Settings Experiments toggle (only warms when a LOCAL model is pinned), TTFT measurement (525b7c6).
  NEEDS LIVE TEST for the warm-vs-cold TTFT delta. v0.2 speculative draft is future, gated on a measured win.
- [ ] **E1 measurement — TTFT (time to first token).** Instrument ms from request-sent to
  first streamed token for chat/session runs; store it on the run/telemetry and surface it so
  the prewarm benefit is measurable (warm vs cold). Lachy wants to ADVERTISE the real number on
  the README (e.g. local models on 8GB VRAM first-token latency). Use the MEASURED number, never
  a made-up one; the README line only goes in once we have a real reading.
  STATUS: BACKEND DONE — ttftMs captured in the Ollama streaming path (start before fetch,
  first-delta guard), stored on ProviderInvokeResult + SessionRun, folded into the session.timing
  audit. Cloud skipped (no streaming seam). Renderer TTFT display + the real README number pending.

---

## ★ LACHY BATCH 4 (2026-07-12, onboarding polish + cleanup)

- [x] **B4.1 — Onboarding: Enter advances the step.** RENDERER. In the first-run wizard,
  pressing Enter should act as Continue/Next (advance to the next step; on the name step, Enter
  submits the name and moves on). Do not let Enter submit nothing or skip the whole flow.
- [x] **B4.2 — Onboarding preference: add Hybrid.** modelPreference becomes "local" | "cloud" |
  "hybrid" (contract addition). The step-2 cards offer Local, Cloud, and Hybrid (let me choose /
  use both). Persist the choice to the profile. Backend contract touch + renderer card.
- [x] **B4.3 — Remove the hardcoded account email.** RENDERER. `ACCOUNT_EMAIL =
  "bytehavencreations@gmail.com"` (App.tsx ~460) is shown in the account menu head (~2758) and
  is now redundant + a privacy leak. Show the profile NAME instead (reuse the profile the sidebar
  already uses); drop the hardcoded email constant. No email feature exists, so nothing else to remove.

---

## ★ FUTURE / BACKLOG (Lachy-requested, not yet scheduled)

- [x] **F1 — System tray app.** A native tray icon (routing status, pause routines, recent runs),
  close-to-tray vs quit. Lachy: make the tray look nice. Electron Tray + Menu in main.ts + a tidy
  menu; use the app icon.
- [ ] **F2 — Self-serve email digests (SMTP).** Let users send THEMSELVES daily digests, routine/
  schedule results, or manager reports via their own app password / SMTP (never a Metis server).
  Opt-in, BYO-SMTP, so it stays local-first and telemetry-free.

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

- [x] Wire the titlebar global search (currently disabled "coming soon"): search across
  conversations, project files, settings, marketplace — a Ctrl+K command palette.
- [x] Auto-title conversations (first-run summary → conversation title, replacing "New
  conversation").
- [x] Conversation export: copy-whole-chat as markdown + save-to-file (also fixes the
  Privacy>Export disabled state — build the real bridge). Bridge a417ad8, button 30be8f5.
  NEEDS LIVE TEST for the save dialog.
- [x] Streaming Manager chat (backend f70b33a + renderer fcce836) (SSE-style token streaming into the widget).
- [x] Per-conversation token/cost line (reuse telemetry; show at conversation top).
- [x] Prompt templates / snippets library in the composer (slash-command style).
- [ ] First-run tour: a 5-step overlay pointing at Orchestration, Manager, Marketplace,
  Gallery, Benchmark (ties into §17 onboarding).
- [x] Electron-builder packaging config + a GitHub Actions release workflow (so Lachy can
  cut releases by tagging). NOTE: run `npm i -D electron-builder` locally + commit the
  lockfile before CI `npm ci` will pass; see docs/RELEASING.md.
- [x] Error/crash reporting surface (an in-app "last errors" view fed by the audit log).
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
