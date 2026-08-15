# Known limits

Everything Metis does not do yet, or does in a narrower way than the name suggests. This lives
here rather than in the README so the README can describe the product, but nothing in this list is
hidden: each entry is linked from the honest-limits note inside its own README section.

Kept current on purpose. If something here gets fixed it is struck through with the date and the
commit, rather than deleted, so this file also reads as a record of what got closed and when.

## Loops

- ~~**A loop runs alone.**~~ Phase 2A shipped 2026-07-24 (`50ab730`): a continue decision can carry
  up to 3 `spawn` helpers, 9 per loop lifetime, and a finished helper wakes the sleeping loop.
- ~~**A helper is handed the step, and nothing else.**~~ Fixed 2026-07-25: a turn on a chain now
  records an artifact — its real output, code fences intact, unlike the history digest that
  replaces them with "(code)" — and the next position receives it, group members included. So the
  members of `draft -> review & review & review` are handed the draft. The artifact travels as
  `context`, never folded into the task, because routing classifies from prompt text and a draft
  full of code turns "review it" into a build.
- ~~**The helper digest is not scoped to the group that produced it.**~~ Fixed 2026-07-25: helpers
  launched as group members carry the group's `startedAt`, and the wake prompt shows the newest
  group whole plus any ungrouped helpers, rather than a flat lifetime tail.
- ~~**An artifact is one hop, and only the last one.**~~ Fixed 2026-08-06: a turn now sees up to
  three earlier steps' outputs, oldest first and each labelled with the step that produced it,
  within a 6000-character total budget. One hop was wrong for the shape chains are written in:
  `plan -> draft -> review -> synthesise` has a final step whose whole job is combining, and it
  could see only the review, never the draft it was a review of. An over-budget artifact is skipped
  whole rather than truncated, because half an artifact misrepresents what the step produced.
  **Still bounded, on purpose:** three hops, not the whole chain. A step cannot ask for a specific
  earlier step's output — that needs grammar, and the count is the cheap version that covers the
  shape people actually write.
- ~~**A step chain is a ring with no branches.**~~ Partly fixed 2026-08-15: a chain can carry ONE
  conditional edge. `--gate "synthesise fails -> draft" --gate-attempts 3` asks a model that did not
  do the work for a PASS or FAIL after the named step, and a FAIL sends the program counter
  backwards instead of forwards — the "Pass?" diamond from the reference flowchart, and the first
  verdict in this grammar that decides *where* rather than only *whether*. A step can also name what
  it produces (`draft as $draft`) and a later step can ask for it by name (`revise $draft`), which
  makes explicit what the artifact channel already carried positionally.
  **What is still a ring.** One gate per chain, not a general graph: no terminal step, no
  parenthesised sub-chains, and no branch that is itself a chain — those need per-branch program
  counters that do not exist. The gate is capped at 5 attempts, because a conditional edge with no
  ceiling is an infinite loop wearing a condition and this one runs unattended. And **silence falls
  through**: an unreadable verdict, an unreachable judge or a spent allowance all advance the chain
  normally, so a gated chain degrades to exactly the chain it would have been without the gate.
  Guessing FAIL on silence would turn a flaky judge into an infinite retry.
- ~~**No token ceiling.**~~ Shipped 2026-07-24 (`0d48f27`): `/loop --budget 200k` sums the ledger's
  per-loop attribution before and after every turn and settles the loop at `exhausted` with both
  numbers in the reason.
- ~~**A loop cannot check its own work.**~~ Partly fixed 2026-08-06: a turn's operations now become
  `evidence` on its iteration record and are rendered into the next wake prompt, so a loop can
  react to an exit code rather than to its own prose about what it did. It needed no new
  collection — `AgentOperation` already carried `status`, `exitCode`, `stderr` and
  `consoleErrors`, and the tick read `assistantText` off the same object and dropped the rest.
  Narrow on purpose: an operation counts only if it CHECKED something, so a file write is not
  evidence.
- ~~**A loop that needs a human is silently overruled.**~~ Fixed 2026-08-06: a tick now runs with
  an `unattended` stream, so an ask is RECORDED rather than defaulted in silence, and the loop
  settles `blocked` with the question in its reason. The verdict is the same one an absent stream
  produced — the difference is that the loop stops instead of continuing as though permission had
  been considered and refused on its merits. An ask outranks both the model's own verdict (it does
  not know it was denied by absence) and silence (a turn that needed you and then went quiet should
  say which). **Still narrower than it sounds:** the loop parks, it does not wait. Answering has to
  happen on the desktop and the loop is restarted, because the pending maps still store only the
  resolver and never the request, so nothing can enumerate what was asked. Answering a permission
  prompt over HTTP is also a grant made remotely, which is a decision rather than a refactor.
- ~~**A finished loop left no account of itself.**~~ Fixed 2026-08-15: a loop that settles writes
  `walkthrough.md` into the folder it worked in — the routing trace first (difficulty judged, model
  that served it, tokens, cost, per turn), then the files, then what actually got checked, then the
  verdict. The routing trace leads because it is the line no competitor can print: everyone else
  reconstructs a run report from their own tool calls afterwards, and Metis has the depth judgement
  and the serving model as typed records at the moment each turn ends.
  **Four honest edges.** It is skipped entirely in `plan` mode and when the loop has no project
  folder, because a report filed somewhere nobody looks reads as delivered when it is not. It never
  overwrites a `walkthrough.md` it did not write — a foreign file gets a suffixed sibling instead,
  since an unattended loop clobbering a document is discovered late or never. And helper turns are
  named but have no row, because a helper runs in its own conversation — so the cost total
  understates whenever helpers ran, which the file says outright rather than quietly.
  ~~*It also had no snapshot ids.*~~ **Fixed 2026-08-16:** `writeGeneratedFileSet` now returns the
  backup it took, `ProjectToolResult` carries it, and the loop records one per TURN — the
  `lastProjectSnapshot` key holds a single slot, so by the time a five-turn loop settles four of its
  backups are unnameable from there. The walkthrough lists each turn's id **and its folder**, and
  says plainly that only the last is reachable from the app's revert control, so for the earlier
  turns the path is the way back rather than a one-click undo that does not exist.
- ~~**The model that did the work decided whether the work was done.**~~ Fixed 2026-08-15: the
  continue-or-stop call goes to the local rung instead of to whatever answered the work turn, it is
  told it did not do the work, and it is shown the turn's evidence rather than only the turn's
  prose about itself. It can also answer `BLOCKED` — *what I was shown does not tell me either way*
  — which outranks `STOP` when a reply contains both, because a judge that said both has told us it
  could not tell, and filing that as a met goal is the one wrong answer that reads as success.
  **One edge.** With no local model reachable it falls back to the working model, since a null
  decision ends the loop and a self-judge beats no loop; the fallback is recorded on the turn and
  shown in the panel and the walkthrough rather than passed off as independent.

  ~~*This shipped claiming the inline path was the low-stakes half "by construction": a turn doing
  real work routes to the build pipeline, whose reply cannot carry a block.*~~ **That was wrong, and
  was corrected 2026-08-16.** Every wake prompt appends the decision block unconditionally, so any
  turn that routes to CHAT answers inline — which is every step of
  `plan -> draft -> review -> synthesise`. The self-graded path was the whole flowchart-chain
  feature, not an edge case; only file-writing turns ever reached the separate call. An inline
  `continue` is now re-checked by a model that did not do the work.
  **Only a continue.** Stopping is the recoverable direction and needs no second opinion, and
  `blocked` claims nothing so there is nothing to check — verifying either would double the calls to
  re-confirm the answer that was already safe. A null verdict KEEPS the turn's own continue: unlike
  the fallback path, silence here is not the absence of a decision, and an unreachable judge is not
  evidence against one. And a confirmed continue keeps the working model's own delay and spawn
  requests, because the judge was asked whether to go on, not how.
- ~~**A running loop was invisible in the chat it came from.**~~ Fixed 2026-08-15: a loop carries a
  conversation id from creation (the one it was started from, or a fresh one when started from an
  empty new session) instead of inheriting whatever thread its first tick happened to mint, and its
  turns land there marked as the loop's own work — a centred `Loop turn 2 of 5 — fix what fails`
  marker where a user message would be, then an ordinary run card. The wake prompt is deliberately
  never stored as the user's message: it is the goal plus a history digest plus the helper list plus
  the protocol block, and attributing that to the person would be a worse lie than hiding the turn.
  **One edge.** A loop started from an empty new session has a thread that does not exist until its
  first turn lands, so the view jumps there at that moment rather than immediately. The 20-second
  poll this shipped with is gone — see the push channel below.
- ~~**Nothing pushed background work to the renderer.**~~ Fixed 2026-08-15: `broadcastLoopsChanged`
  in `main.ts` sends `metis-loops:changed` to every open window from inside `mutateLoops`, the one
  choke point every loop write already passes through. Before it, every main-to-renderer channel in
  this app was an `event.sender.send` — a reply inside an `invoke`, addressed to whoever asked —
  which works for streaming a run the user started and not at all for work that starts from a timer.
  So two surfaces polled: the conversation feed every 20 seconds and the Loops panel every 10.
  **Narrower than "a push channel" sounds.** It is one signal about one store, not an event bus, and
  it carries **no payload** — loop records hold their whole history including per-step artifacts, so
  sending the list on every write would push tens of kilobytes to say "something moved". Subscribers
  re-read through the `list()` they would have called anyway, which is also why the channel leaks
  nothing. Both subscribers keep a timer: the feed's only when the preload is too old to have
  `onChanged`, and the panel's permanently, because it also drives the relative-time display and a
  dropped push must not leave a "running" badge on a loop that finished.
- **The capability check is a heuristic, and it warns rather than blocks.** It reads what models
  are AVAILABLE, since a loop routes through the Auto Router at each tick and the answering model
  is not knowable at creation. It cannot promise that a model above the ~7B bar will follow the
  protocol, only that nothing below it reliably does. Deliberately never refuses: Metis is
  local-first, and a gate that only passed metered cloud models would invert the product's own
  argument for the feature.
- ~~**No tray presence for sleeping loops.**~~ Shipped 2026-07-24 (`5da4760`): live loops get their
  own tray section with status, turn count, budget and a Stop item, and the one-line status says
  "idle, 2 loops waiting" rather than a flat "idle" while something is armed to spend money later.

## Safety and recovery

- ~~**Conversation writers were read-modify-write.**~~ Fixed 2026-08-05: all ten now go through
  `mutateConversations`, which serialises and re-reads inside the lock, so a loop turn and its
  up-to-three helpers can no longer overwrite each other's turns. Modelled offline in
  `14-conversation-races`, where the old shape kept 1 of 4 concurrent conversations. The
  auto-titler was the worst of them: it re-read just before writing, which narrowed the window
  without closing it, behind a model call that takes seconds. `writeConversations` now has exactly
  one call site and the suite asserts that on the source, because the unsafe shape reads perfectly
  naturally and the eleventh writer would otherwise be added the same way.
- **Serialised writes are process-local.** Two Metis processes sharing one store still race, for
  conversations exactly as for loops. It is why a CLI loop carries its own origin and is never
  resumed by the app.
- **Undo is one deep.** Only the most recent generated write can be reverted from Settings. Older
  snapshot folders still exist on disk with their manifests, but there is no history browser.
  `revertSnapshot` itself takes a whole snapshot object and can restore any of them; what is missing
  is anything that hands it one other than the `lastProjectSnapshot` key, which holds a single slot
  that every later write overwrites. Since 2026-08-16 a loop's `walkthrough.md` at least **names**
  each turn's backup folder, so the older ones are findable by hand — see the walkthrough entry
  under Loops.
- **A revert never deletes files the run created.** Restoring content is safe and reversible;
  deleting a file you may have edited by hand since is not. Deliberate, and stated in the panel.
- **`plan` mode is a pipeline guarantee, not a sandbox.** It stops the build path before it can
  write and `gatePermission` defensively refuses anything that still reaches it. That is a strong
  read-only guarantee for the build path specifically, not OS-level isolation.
- **`gatePermission` is not the only code that touches disk.** The Graph View document viewer has
  its own read and write IPCs guarded separately by `assertMetisFilePathAllowed`. Path containment
  is consolidated; a single permission gate for the whole app is not a claim this repo makes.
- **Key encryption depends on the OS.** `safeStorage` where the platform provides it, base64 on
  disk where it does not. The app shows you which one is in use rather than implying encryption it
  does not have.
- ~~**The permission ceiling bound loops and nothing else.**~~ Fixed 2026-08-05: `clampPermissionMode`
  was applied only in `createLoop`, so `resolvePermissionMode` handed the renderer's requested mode
  straight to `gatePermission`, which short-circuits on `bypass` for every scope. The clamp now sits
  in `resolvePermissionMode`, the choke point every session entry point shares. Latent rather than
  live — nothing untrusted reaches that IPC — but it had to precede the first HTTP route that can
  start a run rather than follow it.
- **There is still no CSP**, and it is designed rather than shipped. Audited 2026-08-05: no meta
  tag, no `onHeadersReceived` header, nothing. Last of the three renderer-trust preconditions, and
  deliberately not guessed at, because a CSP fails in a way a typecheck cannot see — it looks
  correct, ships, and then breaks the dev loop or a hidden feature the next time somebody opens it.

  **Deliver it as a header via `session.defaultSession.webRequest.onHeadersReceived`, not a meta
  tag in `index.html`.** The two environments need different policies and a meta tag cannot vary by
  environment without editing the file that both builds share.

  Packaged (`file://`), the strict one that is actually worth having:

  ```
  default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:*;
  frame-src 'self' http://127.0.0.1:*; base-uri 'none'; object-src 'none';
  form-action 'none'
  ```

  Development additionally needs `'unsafe-eval'` in `script-src` and `ws://127.0.0.1:*` in
  `connect-src`, because Vite's HMR client uses both. That is the whole reason the two differ, and
  the reason a single policy would either break `npm run dev` every morning or be too loose to be
  worth shipping.

  Four constraints that each individually break a naive policy, three of them found by reading
  rather than by guessing:

  - `style-src` needs `'unsafe-inline'` in BOTH environments. React sets inline `style` attributes,
    and the canvas positions nodes that way; this is not a dev-only concession.
  - `img-src` needs `data:`. Generated images and SVG artifacts both render as `data:` URLs in an
    `<img>`, which is the whole safety argument for how they are drawn.
  - `frame-src` needs loopback with a wildcard port. The preview rail's iframe loads the
    generated-project server on an ephemeral 127.0.0.1 port, so an exact port cannot be written
    down in advance.
  - ~~`connect-src` needs `https://api.github.com`.~~ **Unblocked 2026-08-06.** This was the
    constraint that made a useful `connect-src` impossible: the Marketplace fetched GitHub metadata
    and arbitrary `source_url` values from registry entries, in the renderer. Those moved to main
    behind an allowlist (`isRegistryFetchUrl`), so the renderer now makes exactly one outbound
    request of its own — a `HEAD` to the loopback preview server. `connect-src 'self'
    http://127.0.0.1:*` is therefore now sufficient, and the packaged policy above can drop
    `https://api.github.com` entirely.

  **Verification is the gate, not the writing.** It needs `npm run dev` actually running, HMR
  confirmed working, and the renderer console confirmed free of CSP violations, with the preview
  rail opened at least once. That needs a display and a person, so it waits for one rather than
  being shipped on the strength of looking right.
- ~~**No navigation guards.**~~ Fixed 2026-08-05: `will-navigate` refuses any top-level navigation
  that is not the app itself and hands an `http(s)` target to the OS browser instead;
  `will-frame-navigate` refuses subframe navigation to anything but the app, loopback (the preview
  rail's generated-project server), `about:` or `data:`; and `setWindowOpenHandler` denies every
  new window, routing `http(s)` outward — which is what the one `target="_blank"` link in the app
  already meant. The URL rules are pure and pinned in `08-path-containment`, including that
  `127.0.0.1.evil.example` is not loopback.
- ~~**No IPC sender validation.**~~ Fixed 2026-08-05: `ipcMain.handle` and `ipcMain.on` are wrapped
  once at startup so every channel refuses a sender that is not a top-level frame. Done by patching
  the registration rather than editing ~100 call sites, so the default is guarded and the
  hundred-and-first handler inherits it. The rule is deliberately "reject subframes" rather than an
  origin allowlist: our own windows legitimately load three different URL kinds (dev server over
  http, packaged renderer over `file://`, quick-ask over `data:` whose origin is `null`), and the
  thing worth excluding is the preview iframe, which is excluded by being a subframe. Nothing
  reached it before — a subframe has no preload and `nodeIntegrationInSubFrames` is false — so this
  stops the guarantee depending on a default staying default.
- **The renderer is still trusted, and the CSP is what is left.** `contextIsolation` is on and
  `nodeIntegration` off, and the chat renders through react-markdown with no `rehype-raw`, so
  model-authored HTML is stripped rather than executed and nothing untrusted runs in that origin.
  Closed in the same audit: the generic store channel no longer reaches the `secrets` key
  (`13-store-key-guard`).
- **The phone page is watch-and-stop only, and that is a boundary rather than a milestone.** The
  gateway serves `/v1/loops`, `/v1/loops/:id` and `/v1/loops/:id/stop` plus a page that polls them.
  There is deliberately no route that STARTS a run: starting one spends money and carries a
  permission mode, so it is the route that has to be designed rather than added. Reading is safe,
  and stopping can only ever reduce what the machine is doing.
- **The page accepts its token from a query string.** A browser cannot attach an `Authorization`
  header to a URL you type or scan, so `?token=` is the one bootstrap route in. Only the HTML page
  accepts it, never the JSON routes, and the page moves it into `sessionStorage` and strips it from
  the address bar on load. It still lands in browser history and would land in any proxy log, which
  is survivable for a loopback service reached over a private tunnel and would not be for a public
  one. A per-device pairing token with its own revoke would be the real fix.
- **One token, total authority.** The same bearer that lists loops also unlocks
  `/v1/chat/completions`, which spends real money. There are no scopes, no per-route gating, no
  rate limiting, no origin check and no CORS handling. The phone page is served BY the gateway so
  it is same-origin and needs none of those — but binding the gateway anywhere other than
  `127.0.0.1` would need all of them first.
- **`shell.openExternal` accepts any `https?` URL from the renderer.** Its only check is the
  protocol, so it is a working outbound channel for anything already running in the renderer. Same
  precondition as above, and the same reason it is written down rather than fixed: an allowlist
  that has to cover every legitimate link the app opens is a change worth making deliberately.

- **The model catalogue is only partly live.** It used to be hardcoded and going stale silently:
  the 2026-08-14 refresh (docs/MODEL_CATALOGUE.md) found DeepSeek's `deepseek-chat` and
  `deepseek-reasoner` retired on 2026-07-24 and still being sent from eleven call sites — every
  DeepSeek route in v1.2.0 was pointing at a dead id, and nothing in the app could have noticed
  because nothing ever asked a provider what it serves. Since 2026-08-15 a catalogue refresh also
  fetches OpenRouter's no-auth `/api/v1/models` and Ollama's `/api/tags` from the main process,
  merges them over the bundled list, and drops anything past its provider-declared expiry.
  What is still hardcoded: every **direct** first-party route. An OpenRouter id is deliberately
  never inverted into an Anthropic or DeepSeek one (their ids disagree on dots, dashes and dates,
  and `deepseek/deepseek-v4-flash` is pinned to an older snapshot than first-party), and neither
  Alibaba nor Z.ai publishes a list at all. So Qwen, GLM and the direct provider routes are still
  correct only on the day they were written; the live sources catch new and retired models, not
  those.

## Verification

- **CI now runs the offline suites on every push** (`.github/workflows`), 24 suites via
  `npm test`, covering the loop decision layer, the `/loop` grammar (including `--budget`), the
  permission clamp, path containment, edit-intent routing, the store-mutation race, the file-edit
  line-diff counts, the per-node depth rung rule, the chain artifact channel, the renderer's reach
  into the store, the conversation-store race, the SVG render gate, the live model-catalogue
  mappers, the loop walkthrough, the think-token ceiling, the per-reader retrieval policy, the loop gate and named outputs, the loops push channel, the rung ledger, and the honesty of this documentation itself. They cover the adversarially-important slices, not the breadth of `src/`.
- ~~**An SVG only renders when the model labels the fence `svg`.**~~ Fixed 2026-08-14. Found in
  first live use: Qwen3 8B answered a chart request with a correct, complete SVG inside an
  ```xml fence and it printed as code, because the renderer tested the LABEL and never reached
  the content check. The gate is now `fenceMayBeSvg` — svg, xml, html, markup, or a bare fence
  are all looked under, and `isRenderableSvg` still decides. Pinned in `15-svg-artifact` with the
  exact Qwen output that failed.

  Worth recording why this shape of bug matters here more than elsewhere: ask Claude and you get
  ```svg and it works; ask a local 7B and you get ```xml and it does not. A feature that silently
  depends on which model answered is the specific failure this product cannot afford, because
  routing across models is the whole argument.
- **Nothing in the artifact path is verified in a running app.** The SVG gate and the generated-image
  contract are pinned offline, and the renderer wiring is typechecked, but no recorded run shows a
  chart actually drawn in a bubble. It is `SHIPPED`, not `VERIFIED`, and for the usual reason: the
  manual walkthrough is the missing half.
- **The docs are checked against the code, but only where a claim is mechanical.** `12-doc-honesty`
  verifies that every `FLAG OFF` feature names a store key that really falls back to off, that
  `doctor` reports every boolean flag the app reads, that the not-built-yet table contains nothing
  already built, that internal doc links resolve, and that a claimed suite count is the real one.
  It cannot check whether a paragraph of prose is a fair description of what the code does. It
  catches the decay that follows shipping, not inaccuracy at the time of writing.
- **The manual walkthrough checklist is unticked.** It is kept privately rather than in the repo,
  but the consequence is public: it is why most README sections say `SHIPPED` rather than
  `VERIFIED`.
- ~~**The Auto Router fix has not been proven in a packaged build.**~~ Proven 2026-07-21: an
  `electron-builder --dir` build (`release/win-unpacked/Metis Orchestrator.exe --cli chat … --json`)
  produced a real `metis-policy-cli` decision — deterministic ruleset, full evidence and scores —
  and a real routed provider answer, end to end inside the packaged executable. The remaining
  narrower caveat: that run used the unpacked directory target, not the NSIS installer output,
  which shares the same asar/app layout but is not literally the installed artifact.
- ~~**The newest tag is `v1.1.0`, and `main` is well ahead of it.**~~ Closed 2026-08-14 by cutting
  `v1.2.0`, which carries the 58 commits that had accumulated since — loop chains, per-node depths,
  image generation, in-chat artifacts, the phone surface and the loop feedback channel.
- **Project files are sent to whichever provider answers, and that is the design.** An edit turn
  reads up to 12 files from the selected folder and puts their contents in the prompt. It has to:
  a model cannot change code it cannot see, and routing that work to a provider is the entire
  product. The consequence is worth stating plainly rather than burying — **a credential sitting in
  a project file goes with it.** `.env` is skipped, but by extension allowlist rather than policy,
  so `config.json` or a key hardcoded in `script.js` is included. Metis does not scan file contents
  for anything secret-shaped and does not warn. Decided 2026-08-14: this is a stated position, not
  an unfinished feature. A heads-up when an outgoing file looks like it carries a key would be a
  courtesy, and is not built.

## Narrower than the name suggests

- **The Benchmark is simulated.** A hardware sizing guide, not measured inference.
- **Fan-out is sequential.** Named sub-agents with real file territories, executed one at a time.
- **Usage limits do not throttle.** Display-only, and the section is hidden in v1 anyway.
- **The router does not learn from you.** Metis keeps a private local log of how you actually use
  it and shows it back as plain-sentence observations. Nothing in it changes routing. It is a
  record, not a decision.
- **The Auto Router classifies by keyword rules plus a length rule**, not a learned model. The
  confidence numbers are fixed constants, so read them as a category label rather than a calibrated
  probability.
- ~~**The knowledge bank gave every model the same four chunks.**~~ Fixed 2026-08-15: how much
  retrieved context a run gets is now chosen from the model about to read it — one chunk over a 0.55
  floor under 10B, two chunks to 32B and for a local model whose tag does not state a size, and the
  existing four for everything larger and for every cloud model. `knowledgeBankEnabled` defaulting
  to true was a *measured* loss on small local models: given a perfect oracle passage a 7B extracted
  the right answer ~15% of the time, adding retrieved context destroyed 42–57% of answers it had
  previously got right unaided, and net expected accuracy from deploying RAG at 7B is −2.9 points
  (docs/MEMORY_AND_LINKS.md).
  **What it does not do.** It keys on the reader, never on the Depths judgement — Depths is off by
  default, so a depth-keyed policy would have done nothing for most installs while the harm applied
  to all of them. Size comes from the model **tag**, because Ollama's byte size folds quantisation
  in and a 4-bit 30B looks like an 8-bit 13B; a tag with no size gets the middle posture rather than
  either extreme. The 10B line is the paper's own; the 32B line and the 0.55 floor are judgement
  calls that no study reaches. **Controls landed 2026-08-15** under Settings > Chat > Knowledge
  banks: the bank's own on/off (which had never had one at all) and an Automatic / Minimal /
  Conservative / Full override. `Full` is offered and warns in the same breath that it re-enables
  the measured 42–57% destruction on a small local reader, because an override that hides what it
  costs is worse than no override.
- ~~**Depths guesses once and never revisits.**~~ Partly fixed 2026-08-15: a turn routed to a
  **local** rung under Depths now carries a thinking budget, and a model that spends the whole
  budget without starting an answer has its stream cut and the turn re-run one rung deeper. That is
  the only place routing corrects itself in this repo — every other correction mechanism here
  (fallback chains, the critic loop, the loop judge) reacts to a failure, and routing had no failure
  signal at all. The overrun is free information about difficulty, available *before* the answer is
  paid for.
  **Four limits, none of them incidental.** It is local-only, because Ollama is the one provider
  whose reasoning Metis sees token by token; every cloud provider bills for thinking that can only
  be measured after the money is spent. It fires **only while thinking is all the model has
  produced** — once an answer has started the deliberation is over, and aborting then would discard
  a real answer to punish a long preamble. It promotes **once**: the retry has no ceiling of its
  own, or one hard prompt could walk the whole ladder burning a call per rung, and a turn already on
  the deepest rung fails rather than re-running the same model. The ceiling is a runaway detector
  with a deliberately generous default (1500 tokens), and since 2026-08-15 it has a field under
  Settings > Chat > Experiments — 0 switches it off, which had to be reachable, because this is the
  one setting in the app that can abort a generation already in flight.

## Closed

- ~~**Five races in the loops store.**~~ Fixed 2026-07-19 (`63062be`): every mutation is now
  serialised and re-reads inside the lock, so a Stop clicked during a turn can no longer be
  overwritten by that turn's own final write. Also closed: two concurrent turns for one loop, the
  tray pause being checked once per pass, and the 60s timer being pushed out indefinitely by
  unrelated panel activity.

- ~~**Loops could only ever do one turn of real work.**~~ Fixed 2026-07-19 (`4222546`): a turn
  that routes to the build pipeline returns a pipeline summary rather than a model reply, so no
  decision block existed and the loop always stopped after one turn, having looked like it worked.
  The decision is now asked as a separate small call when the work turn cannot carry one. Verified:
  14 of 14 functions documented across 4 self-directed turns, stopping itself when the job was done.
- ~~**You cannot start a Loop from the app.**~~ Fixed 2026-07-19 (`62d49f5`): `/loop <goal>` with
  `--turns` and `--every`, plus a live hint strip in the composer.
- ~~**Stopping a run erases the answer you were reading.**~~ Fixed 2026-07-19 (`b979a50`): a stop
  is now its own state, keeps the streamed text, and reads neutral rather than as an error.
- ~~**The tray's pause did not cover loops.**~~ Fixed 2026-07-19 (`b979a50`): both scheduler chains
  honour it and the label says so.
- ~~**The composer's Stop killed background loops in the same folder.**~~ Fixed 2026-07-19
  (`81c9aee`): loops run in their own cancel scope.
- ~~**`agentToolsEnabled` had no UI and was developer-only.**~~ Fixed 2026-07-19: it is now a
  toggle in Settings > Chat > Experiments, with the containment and secret-denylist behaviour
  described in the copy.
- ~~**`doctor` claimed routing "falls back to a static sample".**~~ Fixed 2026-07-19: stale wording
  from before the built-in router existed, and it described the exact bug that had been fixed.
