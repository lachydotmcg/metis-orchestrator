# Changelog

All notable changes to Metis Orchestrator are documented in this file.

`1.0.0` is the first release documented here rather than the first tag:
`v0.1.0` and `v0.2.0` were cut on the two days before it and have no
entries, so that section reads as a feature summary rather than a delta.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the app is put
together and [`docs/ORACLE.md`](docs/ORACLE.md) for the speculative-inference
engine referenced below.

## [Unreleased]

Nothing yet.

## [1.2.0] - 2026-08-14

The first release since `1.1.0` on 2026-07-20, and a large one: 58 commits
that never reached anyone who installs Metis rather than building it.

The through-line is loops that can be left alone. Before this, an
unattended loop could not tell whether its own work succeeded, could not
say that it was unsure, and — worst of the three — carried on as though
answered when it hit a permission gate nobody was there to answer. All
three are closed. A run now stops and says what it needed.

The rest: watch and stop your loops from your phone, generated images and
`svg` blocks render in the chat instead of printing a file path or raw
markup, and a batch of security work that was latent rather than live but
had to precede the artifact rendering rather than follow it.

### Added (2026-08-06)

- **A chain step can see more than one hop back.** Up to three earlier
  steps' outputs, oldest first, each labelled with the step that produced
  it, within a 6000-character total budget.

  One hop was wrong for the shape chains are actually written in.
  `plan -> draft -> review -> synthesise` has a final step whose entire job
  is combining, and it could see only the review — never the draft that
  review was of. Two steps that both produced work handed only the later
  one forward and the earlier was silently discarded.

  Labels matter as much as the count: three unattributed blobs leave a
  synthesise step guessing which is the draft and which is the critique,
  which is the guessing carrying them forward was meant to stop. Newest
  survives the budget, because the most recent output is the most likely to
  matter; oldest renders first, because reading them in order is reading
  the story in order. An over-budget artifact is skipped whole rather than
  truncated — half an artifact misrepresents what the step produced.

- **A loop that needs you stops and tells you, instead of being silently
  overruled.** The third face of the feedback channel. A tick used to run
  with no stream at all, which meant `promptForPermission` returned
  `deny` and `promptUserQuestion` answered its own question with the first
  option — and the run then carried on as though it had been answered.

  Ticks now run with an `unattended` stream. That is a third state
  alongside "has a stream" and "has none", and it exists because both of
  those are wrong for a loop: no stream defaults the ask silently, and a
  normal stream waits five minutes for a renderer that does not exist and
  then defaults anyway. Unattended records the ask, does not wait, and
  lets the tick settle the loop `blocked` with the question in its reason.

  An ask outranks the model's own verdict, because the model may well have
  said "continue" — it does not know its permission was refused by absence
  rather than on the merits. It also outranks silence, because a turn that
  needed you and then went quiet should say which.

  The loop parks; it does not wait. Answering still happens on the desktop
  and the loop is restarted. Enumerating what was asked needs the pending
  maps to carry the request rather than only the resolver, and answering a
  permission prompt over HTTP is a grant made remotely — a decision rather
  than a refactor, so both are recorded rather than guessed at.

- **A loop can see whether its work actually worked, and can say it
  could not check.** Two of the three faces of the feedback channel
  designed in `docs/ROADMAP.md`.

  A turn's operations now become `evidence` on its iteration record and
  are rendered into the next wake prompt, directly above the decision
  block — so the loop's own results are the last thing it reads before
  choosing. This needed no new collection: `AgentOperation` already
  carried `status`, `exitCode`, `stderr` and `consoleErrors`, and the tick
  was reading `assistantText` off the very same object and dropping the
  rest. The rule for what counts is narrow — an operation must have
  CHECKED something, so a command's exit code and a browser check's
  console errors qualify and a file write does not. Counting file writes
  would let a loop "verify" itself by writing a file. Failure detail trims
  from the FRONT, the opposite of the artifact's middle-trim, because a
  stack trace's useful line is its last.

  The decision block gains a third verdict, `blocked`, settling the loop
  at its own status rather than `stopped`. Stopping reads as success and
  continuing burns turns against a wall; neither is honest when a run
  cannot verify its result or needs a decision only the user can give. An
  agent that cannot distinguish *done* from *unverifiable* will always
  choose done. Blocked loops surface on the phone page — the one status
  most worth carrying in your pocket, and the one a live-only filter would
  have hidden.

  Suite 01 caught two real problems while this was written: the new
  instruction contained the word "make", which steers routing and is
  banned from the wake prompt for that reason, and it pushed the prompt
  past the 600-character bound that keeps the goal dominant. The third
  verdict now shares a line with the second rather than adding one.

### Changed (2026-08-06)

- **The fenced blocks a model may emit are declared in one place.** Four
  parsers had grown independently around the same shape — match a fence,
  parse the payload, validate it, turn it into something that is not prose
  — and each had picked its own selection and stripping policy along the
  way. Those differences are load-bearing: `metis-loop` takes the LAST
  block because a model reasoning out loud may show an example first, and
  `metis-actions` is anchored to the END of the reply and removed from the
  visible text. Neither is arbitrary and neither was findable without
  reading both regexes.

  `src/shared/model-blocks.ts` now declares each type's tag, selection,
  whether it is stripped, and — the field that is the point of the
  exercise — its **render boundary**: what the block is allowed to become.
  SVG becomes an `<img>` data URL, which cannot execute script whatever
  the markup contains. HTML would need the iframe and origin work that is
  not built. Making that a required field means the next block type cannot
  be added without someone deciding.

  Fences, never XML: Claude.ai can use `<antArtifact>` because one model is
  trained to emit it, whereas Metis routes across seven providers and
  Ollama and its own argument is that trivial work stays on a local 7B —
  which will not reliably emit well-formed XML but will emit a fenced
  block. `extractManagerActions` had already chosen a fence for that
  reason.

  Behaviour is unchanged, and that was verified rather than asserted: the
  suites that already covered the two migrated parsers passed without a
  single edit. `extractGeneratedFilesFromText` is deliberately NOT
  migrated — it matches every fence regardless of tag and infers filenames,
  which is a file extractor rather than a block protocol, and forcing it
  onto the registry would have made both worse.

### Added (2026-08-05)

- **Watch and stop your loops from a phone.** The gateway gained
  `GET /v1/loops`, `GET /v1/loops/:id` and `POST /v1/loops/:id/stop`, plus a
  small self-contained page it serves itself that polls them every ten
  seconds and offers one Stop button per live loop. `stopLoop` is the same
  function the tray and the desktop panel already call, so a phone stop and
  a desktop stop are one write through one serialised mutation.

  There is deliberately **no route that starts a run**. Starting one spends
  money and carries a permission mode; it is the route that has to be
  designed rather than added.

  The bind stays `127.0.0.1` and does not move. Reach is `tailscale serve`'s
  job — it also supplies the real certificate a phone needs, since service
  workers and web push require a secure context and the localhost exemption
  does not extend to a LAN IP. Serving the page from the gateway itself
  keeps it same-origin, which matters because the gateway has no CORS
  handling, no origin check and no rate limiting.

  It polls rather than streams: a loop's own heartbeat is 60 seconds, so a
  10-second poll is four times finer than the thing it watches, and polling
  survives a locked screen and a wifi-to-cellular switch with no reconnect
  protocol. Polling pauses while the tab is hidden.

- **A ```svg fence is drawn instead of printed.** Ask for a chart and the
  reply renders it, with "Show code" one click away rather than replaced —
  the model wrote code, and hiding it would make an SVG the one kind of
  output you cannot read or copy.

  Nothing is stored. An image is a real file, so its artifact carries a
  path; an SVG is markup that is already in the run's `assistantText`,
  which is already in `conversations.json`, and that file is rewritten
  whole on every turn. Storing it again would duplicate every chart in a
  file re-serialised on every message, to save a parse costing
  microseconds. So detection happens where the fence is rendered.

  Drawn through the same `<img>` data URL boundary as generated images.
  An SVG loaded via `<img>` runs in secure static mode — no scripts, no
  external fetches, no interactivity — so nothing strips `<script>`, on
  purpose: a sanitiser would imply the boundary needs one, and people
  start trusting the sanitiser instead of the guarantee.

  The gate (`isRenderableSvg`) exists because Metis routes to small local
  models that truncate constantly, and a broken render is worse than no
  render. Anything not a single complete root SVG stays a code block.
  `15-svg-artifact` pins 31 cases, most of them refusals — it caught a
  real bug during development, where two charts concatenated passed a
  balanced-tag-count check and would have rendered as only the first.
  Counting opens and closes cannot tell one nested document from two
  siblings; it now tracks depth.

- **Generated images render in the chat.** Image generation wrote a real
  PNG and then told you its file path — the one place in the app that
  produced something visual and rendered it as prose. A run can now carry
  `renderedArtifacts`, and the bubble paints them above the reply. The
  file path stays in the sentence: the file is real, and telling you where
  it went is not made redundant by also showing it to you.

  Drawn as an `<img>` with a data URL. An `<img>` cannot execute script
  whatever its bytes contain, so this phase needs none of the CSP and
  sandbox work that HTML artifacts will. Bytes cross IPC rather than being
  loaded as a `file://` src, because in dev the renderer is served over
  http and Chromium refuses a `file://` subresource from an http origin —
  a `file://` src would have worked packaged and failed silently every day
  in development.

  The IPC that serves them has its own narrow path guard
  (`isGeneratedImagePath`): the two folders image generation actually
  writes to, and nothing else. Deliberately not the document viewer's
  guard, which answers a different question using workspace grants —
  generated images land outside any workspace when no project folder is
  selected, so reusing it would have meant widening it. Pinned in
  `08-path-containment`, including that a source file, a `.env`, and the
  secrets store in the same folders are all refused.

### Fixed (2026-08-05)

- **Concurrent runs no longer overwrite each other's chat history.**
  `appendRunToConversation` read the whole conversation list, awaited, then
  wrote a list built from the snapshot it took before that await. With one
  turn at a time that was theoretical; phase 2A ended that, since a loop
  turn can spawn three helpers and each is a full tracked run appending
  through the same store. Four writers, four stale snapshots, slowest wins,
  and a turn you watched appear is gone after a restart. It now goes through
  `mutateConversations`, which serialises and re-reads inside the lock —
  the same shape as `mutateLoops`, which fixed this exact bug one store
  over. Modelled in `14-conversation-races`, where the old shape kept 1 of
  4 concurrent conversations and the new one keeps all 4. All ten writers
  are converted — create, delete, archive, fork, rename, set-project,
  delete-by-project and the auto-titler included. The auto-titler was the
  worst of them: it re-read just before writing, which narrowed the window
  without closing it, behind a model call that takes seconds.
  `writeConversations` now has exactly one call site, and the suite asserts
  that against the source, because the unsafe shape reads perfectly
  naturally and the eleventh writer would otherwise be added the same way.

### Security (2026-08-05)

- **Navigation guards and IPC sender validation**, two of the three
  renderer-trust preconditions recorded in `docs/LIMITATIONS.md`.

  `will-navigate` refuses any top-level navigation that is not the app
  itself and hands an `http(s)` target to the OS browser instead.
  `will-frame-navigate` refuses subframe navigation to anything but the
  app, loopback, `about:` or `data:` — loopback stays allowed because the
  preview rail's iframe legitimately loads the generated-project server on
  an ephemeral port, and blocking it would break a shipped feature.
  `setWindowOpenHandler` denies every new window and routes `http(s)`
  outward, which is what the app's one `target="_blank"` link already
  meant.

  Sender validation wraps `ipcMain.handle` and `ipcMain.on` once at
  startup rather than editing ~100 call sites, so the default is guarded
  and the hundred-and-first handler inherits it. The rule is "reject
  subframes" rather than an origin allowlist: our own windows legitimately
  load three kinds of URL — dev server over http, packaged renderer over
  `file://`, quick-ask over `data:` whose origin is `null` — and the thing
  actually worth excluding is the preview iframe, which a subframe check
  already excludes.

  Neither was reachable: a subframe has no preload and
  `nodeIntegrationInSubFrames` is false. This stops the guarantee
  depending on a default staying default. The CSP is still open, and is
  the fiddly one — Vite's dev server needs inline styles and `eval` for
  HMR while a packaged build needs neither.

- **The renderer can no longer reach the `secrets` store key.**
  `metis-store:get` forwarded any key to `readStoreValue` with only a
  character check, and provider API keys live at that key —
  `readSecrets` is `readStoreValue("secrets", {})`. So the generic store
  channel was a second, unguarded route to the key file, sitting beside
  the deliberately narrow `metis-secrets:list`, which returns which
  provider and which storage tier and never a value. Blocked for writes
  too: overwriting that key generically would clear every provider key
  with no audit line, while the dedicated set and delete each write one.
  Nothing in the renderer asked for it generically, so nothing changes
  for users.

  It was not reachable. The chat renders through react-markdown with no
  `rehype-raw`, so model-authored HTML is stripped rather than executed
  and nothing untrusted runs in the renderer's origin. This is defence in
  depth ahead of in-chat artifacts, which is the change that would make
  it reachable.

### Changed (2026-08-05)

- **Three standing preconditions are now written down** in
  `docs/LIMITATIONS.md` rather than merely being true: there is no CSP,
  no navigation guard, and none of the ~100 `ipcMain` handlers validates
  its sender. `contextIsolation` is on and `nodeIntegration` off, so none
  of it is a hole today — it is a set of assumptions that in-chat
  artifacts would invalidate, and they should land together with that
  work. `shell.openExternal` accepting any `https?` URL is recorded for
  the same reason.

### Added (2026-07-26)

- **The documentation is checked against the code by CI.** A new offline
  suite verifies that every `FLAG OFF` feature names a store key that
  really falls back to off, that `doctor` reports every boolean flag the
  app reads, that the "Designed, not built yet" table contains nothing
  already built, that internal doc links resolve, and that a claimed suite
  count is the real one. The marker table in the README was a promise kept
  by hand until now, and prose describing a gap outlives the gap: three
  separate corrections were needed in one week for features that had
  shipped. It checks whether a claim is still true, not whether it was ever
  fair.
- **`doctor` reports two flags it was silently missing.**
  `agentToolsEnabled` — which decides whether a model may read and edit
  your files, and was the only flag with real blast radius you could not
  check without opening Settings — and `followupsEnabled`. Found by the
  suite above on its first run.

### Fixed (2026-07-25)

- **A parallel step group is handed the work it is meant to act on.** Each
  member of an `&` group was invoked with the bare step string as its
  entire prompt, so `--steps "draft -> review & review & review"` started
  three helpers whose whole instruction was the word "review" — reviewing
  a draft they had never been shown. A turn on a chain now records an
  artifact (its real output, code fences intact, unlike the history digest
  that replaces them with `(code)`) and the next position receives it,
  group members included. The artifact travels as `context` and is never
  folded into the task, because routing classifies from prompt text and a
  draft full of code turns "review it" into a build. Still one hop and only
  the last one, which is recorded in `docs/LIMITATIONS.md` rather than left
  to be discovered.
- **Helper summaries are scoped to the group that produced them.** The wake
  prompt rendered a flat loop-lifetime window, so a second pass through a
  chain mixed this cycle's helpers with the last cycle's and rendered
  nothing to tell them apart.

### Added (2026-07-22)

- **Image generation route.** "Generate an image of X" now routes to a
  dedicated Image Generation pipeline with a July-2026 catalog — GPT
  Image 2, Nano Banana 2 (Gemini 3.1 Flash Image, the default) and Nano
  Banana Pro — as a fallback chain. Images write as new timestamped
  files under the project's `images/` folder. FLUX.2 is the noted
  follow-up (needs its own provider + secret slot).
- **`--conversation <id>` for the CLI.** `chat` and `build` runs print
  their conversation id and can continue an earlier one, so a multi-turn
  sequence gets real context carry-over headless instead of every turn
  starting fresh.

### Changed (2026-07-22)

- **Depth levels reversed.** L1 is now the hardest tier on your strongest
  model and higher numbers get cheaper, leaving room for future L4/L5 at
  the cheap end. Picking an L1 model rewrites the node itself; the
  "Default" row is gone from the level picker; existing stacks migrate
  once on load.
- **License is FSL-1.1-MIT.** Use, fork and run it freely; the one
  restriction is selling a competing product, and every release converts
  to plain MIT two years after it ships.

### Fixed (2026-07-22)

- **Depth routing sweep.** Trivial fast-lane turns are depth 1 outright
  (a two-word prompt no longer pays for a pinned cloud rung), and
  analysis questions ("analyse the trade-offs… and recommend a design")
  stay in chat instead of running the file-writing build pipeline.
- **Two-process routing honesty.** A depth rung's display name ("Opus
  4.8") is resolved to its API id before the provider call, and a
  statement opening with "when" ("When something goes wrong… fix it") is
  no longer misread as a question and routed to chat.

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
- **Flowchart Loops.** `/loop --steps "read -> plan -> research & review
  -> implement"` gives a loop an ordered step cycle with a wrapping
  program counter: each turn runs (and routes as) its current step, and
  a "&" group runs its members side by side as helpers before the chain
  moves on — completions wake the loop, waiting costs no iterations.
  The panel shows step N of M with the chain on hover; groups cap at 3,
  the chain at 8 steps because it replays every turn. Parenthesised
  multi-step branches are still refused with a coming-later message.
  Three one-click loop starters also join the "/" popover, and
  `/loop --flowchart <goal>` asks a model to draft the chain — the
  proposal lands back in the composer as an ordinary `--steps` command
  to review and edit before anything runs.
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

## [1.1.0] - 2026-07-20

Tagged and released, and until now undocumented: every section below this
heading shipped in `v1.1.0`, and everything above it landed after the tag
and is still unreleased. The split is by date against the tag, so an entry
dated later than 2026-07-20 belongs above.

129 commits separate this from `1.0.0`, and the sections below are the
notable ones rather than all of them.

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
