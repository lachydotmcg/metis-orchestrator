# Changelog

All notable changes to Metis Orchestrator are documented in this file.

`1.0.0` is the first release documented here rather than the first tag:
`v0.1.0` and `v0.2.0` were cut on the two days before it and have no
entries, so that section reads as a feature summary rather than a delta.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the app is put
together and [`docs/ORACLE.md`](docs/ORACLE.md) for the speculative-inference
engine referenced below.

## [Unreleased]

### Security (2026-08-16)

- **The generic store channel could read pooled account credentials.** The
  renderer guard blocked exactly one key, `secrets`. Pooled per-account
  credentials are written to `account-secrets` — a *different* key — and
  `storeKeyPattern` accepts a hyphen, so `metis-store:get("account-secrets")`
  passed the guard and came back with `StoredSecret` blobs. Their `plain-local`
  tier is base64 on disk wherever the platform has no `safeStorage`.

  That is exactly the second unguarded path `shared/store-keys.ts` exists to
  close, reopened by a sibling key added later. `gatewayToken` — the auth for
  the entire HTTP surface — and `permissions` — writing it grants filesystem
  access with no audit line — were open the same way. All three are blocked now.
  `providerAccounts` deliberately stays open: it holds a `keyRef` and never a
  key, and the renderer reads it to draw the account pool.

  **The structural half is the actual fix.** A denylist cannot fail safe here,
  because its failure mode is silence — nobody learns a key was missed until it
  is read, and `gatewayToken` shows a `/secret/i` pattern would not have caught
  it either. Every key the main process writes now carries an owner in
  `STORE_KEY_OWNERS`, and `13-store-key-guard` fails the build on an
  unclassified one. Adding a credential-bearing key without deciding who may
  reach it is now impossible rather than merely unlikely.

  **Not reachable by anything untrusted**, and worth saying so plainly rather
  than overstating it: the chat renders through react-markdown with no
  `rehype-raw`, so model-authored HTML is stripped rather than executed, and
  nothing untrusted runs in the renderer's origin. This was latent. It would
  have stopped being latent the moment any part of the renderer was served over
  HTTP — which is the work that turned it up.

### Changed (2026-08-16)

- **Routines are their own module, and their scheduler is finally tested.**
  `src/electron/routines.ts`, 295 lines for **four** injected dependencies —
  the cleanest seam in `main.ts`, which is now 13,397 lines against 15,478 at
  the start of the day. `31-routine-schedule` adds 24 assertions on
  `computeNextRunAt`, which nothing had ever covered: daily rolling past
  midnight and past a month and a year boundary, weekly wrapping to the right
  weekday including the same-day case, and the one that actually bites — a
  laptop that slept for a day comes back with a `lastRunAt` far in the past, and
  counting from it would schedule a time already gone, so the routine fires
  immediately and repeatedly instead of settling onto its interval.
- **The loop runtime is its own module.** `src/electron/loop-runtime.ts`, 1,526
  lines, for thirteen injected dependencies — the same ratio the gateway came out
  at, over twice the size. `main.ts` is now 13,629 lines, down from 15,478 where
  the day started. It deliberately did **not** go into the `./loops.ts` that
  already existed: that file is electron-free on purpose, and `cli.ts` and
  `gateway.ts` both import it precisely because doing so costs them nothing. The
  runtime needs `BrowserWindow`, so merging would have dragged electron into
  every consumer of `LoopRecord`. Three ways now, each earning its place —
  `loops.ts` is what a loop IS, `loop-runtime.ts` is what running one DOES.
- **The gateway is its own module.** `src/electron/gateway.ts`, 547 lines carved
  out of `main.ts`, which went from 15,478 lines to 14,967. First cut of
  [`docs/STRUCTURAL_DEBT.md`](docs/STRUCTURAL_DEBT.md) item 1: 78% of `src` sat
  in two files, which is why no model can work on this repo (it cannot return a
  742 KB file complete) and why those files could only be grepped rather than
  read. It **takes** its dependencies rather than importing them — importing
  would make `main -> gateway -> main` — and passing the two dispatch tables as
  values collapses that surface from 42 entries to 15. The same shape `cli.ts`
  already uses for the same reason, including its structural-twin trick for a
  type `main.ts` never exports.
- **Which made the routes testable, and that was the point.**
  `30-gateway-behaviour` drives the real compiled `handleGatewayRequest` with a
  fake request, response and dependency set: 37 assertions about what the routes
  DO rather than what their source looks like. A 401 with no bearer, a 401 on
  `?token=` at a JSON route, a 301 on `/app`, a 403 on each of the four `noHttp`
  members, an audit line on a reduce and none on a read. None of it was reachable
  before the carve, because the gateway lived in a file that imports electron.
  That is item 4 falling out of item 1.


- **A thrown render can no longer blank the app.** There was no error boundary
  anywhere in this renderer, so every render-time throw unmounted the whole tree
  and left `#root` empty — no sidebar, no message, nothing, which is
  indistinguishable from "the app did not load" and sends you looking at the
  wrong layer. It wraps `App` rather than each workspace, because the crash that
  found it was in the **titlebar** — shell, not panel, so a per-workspace
  boundary would have caught nothing. Styled inline and depending on no
  stylesheet, store or bridge: a recovery screen that can itself fail to appear
  is not a recovery screen. Not browser-specific — the same throw blanked the
  desktop app too; the browser client only made it reachable.
- **State seeded with a real fallback keeps it unless something usable arrives.**
  `useState<PulseFeed>(FALLBACK_PULSE)` exists so the render can read
  `pulse.updated` without a guard on every line, and a blind `.then(setPulse)`
  threw that away the moment a call resolved with the wrong shape. An audit of
  ~30 sites that feed bridge results into state found four in that class (both
  `pulse` sites, `policyStatus`, `registry`) plus a Settings block whose
  `nextRegistry.sourceUrl` bare-dereference threw *before* any of the sets could
  help. All guarded by `orKeep`, which is deliberately shallow — null, undefined
  and array/object mismatch, the whole of what was observed. On the desktop this
  could not happen: preload and renderer share one set of types, so a wrong
  shape is a build error. Over HTTP the contract is JSON and nothing checks it.
- **The README no longer contradicts itself about having tests.** It said "there
  are no tests" twenty lines above "an offline test suite (`npm test`, 28
  suites)". Both sentences were written honestly and the existing count guard
  could not see it, because the number it pins was in the sentence that was
  right. `12-doc-honesty` now fails a doc that denies the suites it ships. The
  scripts table also gained the `npm test` row it was missing, and the status
  section now says plainly that `main` is ahead of `v1.2.0` rather than "current
  with everything described on this page".
- **Four channels classified `read` are refused an HTTP route, by name and with
  reasons, in the manifest.** `read` was assigned against the *desktop* threat
  model — "this only reads, so the renderer may have it" — and four channels
  pass that test while failing a different one once the caller is remote.
  `metisRegistry.refresh` takes a `sourceUrl` the main process then fetches,
  which is an SSRF primitive, and it sits one line under `metisRegistry.fetchUrl`
  which is already `decision` for exactly that capability. `metisPolicy.decide`
  runs the router on caller-supplied text and reaches a model when model-driven
  routing is on. `metisPrewarm.route` returns void and causes background work.
  `metisUpdates.check` reaches the internet. Serving
  `bridgeChannelsSafeToServe()` mechanically — which is what the plan said to do
  — would have shipped the first of them. Reading the list back before serving
  it is what caught them.
- **`/app/assets/*` is served with no bearer token, and that is the design.** A
  `<script src>` cannot carry an `Authorization` header, so the renderer bundle
  either goes out unauthenticated or the gateway grows a cookie. The cookie was
  rejected: it is an *ambient* credential, and an ambient credential hands every
  other page in the browser a CSRF path to `POST /v1/chat/completions` — the
  route that spends real money. `SameSite=Strict` would block that, but the
  reason the gateway is safe today is that it has no ambient credential to
  steal, and keeping it that way is worth more than the alternative costs. The
  alternative costs nothing: the bundle is the app's own compiled code,
  byte-identical to what ships inside the public installer, with no key, no
  conversation and no user data in it. Every JSON route keeps its bearer check
  exactly as it was, and the suite asserts the asset branch is the *only* thing
  that runs before the check.
- **The served tree is scoped to `/app/assets/`, and refuses OS metadata.**
  `dist/` is not purely build output — Vite copies `public/*` in verbatim, and a
  OneDrive checkout had a `desktop.ini` sitting in the screenshots folder that
  the first version of this branch would have served. The suite found that by
  walking the real tree with the real policy rather than checking a list of
  extensions someone typed. Nothing in it was sensitive; the shape of the
  problem is that whatever the OS drops into a copied directory gets served.
- **A loop's walkthrough names the backups now, and says which one you can
  actually reach.** Every turn that wrote files gets its snapshot id and the
  folder holding the originals.

  The id existed from the day snapshots shipped — it went to the audit log and
  the `lastProjectSnapshot` store key. It just never went onto the run, so
  nothing reporting on a run afterwards could name the backup that would undo
  it. `writeGeneratedFileSet` returns it now, `ProjectToolResult` carries it,
  and the loop records one **per turn** rather than reading that key when the
  loop settles: the key is a single slot every later write overwrites, so by
  the time a five-turn loop finishes, four of its backups are unnameable from
  there.

  The folder matters more than the id, and that is the honest part. Metis's
  revert control undoes the most recent write and nothing older, so for every
  turn but the last one the printed path is the way back — open it and copy the
  file out. The walkthrough says that outright rather than listing ids beside a
  one-click undo that does not exist. With only one backup the caveat is
  dropped, because there is nothing older to be unreachable.

- **A loop turn no longer talks itself into another turn.** The independent
  judge covered only the path where a work turn produced no decision block.
  A turn that answered inline still graded itself, and an inline `continue` is
  now re-checked by a model that did not do the work.

  The claim this corrects is the interesting part. That limit shipped saying the
  inline path was the low-stakes half *by construction*: a turn doing real work
  routes to the build pipeline, whose reply cannot carry a block, so the judge
  runs on exactly the dangerous turns. Checking it before building found the
  opposite. `composeWakePrompt` appends the decision block **unconditionally**,
  so any turn that routes to chat answers inline — and that is every step of
  `plan -> draft -> review -> synthesise`. Self-grading covered the entire
  flowchart-chain feature; only file-writing turns ever reached the separate
  call.

  **Only a continue is re-checked**, which is the same asymmetry the rest of
  Loops runs on, applied one level up. Stopping is the recoverable direction,
  and `blocked` claims nothing — a model that declines to assert an outcome has
  not graded itself favourably. Verifying either would double the calls to
  confirm the answer that was already safe.

  Three rules keep it from overreaching. A null verdict **keeps** the turn's own
  continue: unlike the fallback path, silence here is not the absence of a
  decision — the turn made one — and an unreachable judge is not evidence
  against it. A confirmed continue keeps the working model's own delay and
  spawn requests, because the judge was asked *whether* to go on, not *how*. And
  an overruled loop reports "an independent model judged this finished" rather
  than "the model chose to stop", because it did not.

- **Stale claims in `docs/FEATURES.md` corrected.** The Loops honest-limits
  paragraph still said the step handoff was one hop (it has reached three since
  2026-08-06) and that a chain has no branches (it carries one conditional edge
  since `1bb58a1`).

### Added (2026-08-16)

- **The browser client's stop button works.** It rendered one that rejected,
  while the capability behind it sat live one route over — `POST
  /v1/loops/:id/stop` has shipped since the phone page. Logic with no way to
  reach it is the specific failure this project keeps catching, and here it was
  sitting behind a button that already existed. The three `reduce`-class members
  are now callable from a browser: `metisLoops.stop`, `metisSession.cancel`,
  `metisPermissions.revoke`. Not a new judgement — `reduce` is exactly the class
  the argument above that stop route describes, that watching and stopping are
  both safe because one is a read and the other can only ever reduce what the
  machine is doing. They dispatch through their own table, separate from the
  reads, because a read that could mutate is one careless merge away when both
  live in one map, and the handler asks "readable?" and "reducible?" as two
  questions rather than one. Every reduce leaves an audit line; reads do not,
  since they are the bulk of the traffic and would bury the lines that matter.
  Verified in a browser: all three land on the server, while `metisLoops.delete`,
  `metisSession.run` and `metisPermissions.respond` beside them still reject.
- **A generated write that looks like a truncated file is refused.** This came
  from one question — *would you run Metis on the Metis repository?* — and the
  answer was no, for a reason two facts make plain once they are put side by
  side. The build pipeline asks models for COMPLETE files (`Return COMPLETE
  files, not snippets` is in the front-end stage prompt verbatim), and
  `writeGeneratedFileSet` overwrites whole files unconditionally. That pairing
  is correct for the greenfield folders the pipeline was built for, where every
  file is one the model just authored. Point it at a real codebase and it is a
  shredder: this repo's own `main.ts` is 742 KB and `App.tsx` is 874 KB, and a
  model asked to return either one complete returns something plausible,
  well-formed, and a tenth of the length. The snapshot makes that recoverable,
  which is not the same as safe — `lastProjectSnapshot` holds a single slot, so
  a five-turn loop leaves four of its backups unnameable from the revert
  control. Now: a write that would replace an existing file over 2 KB with less
  than half its bytes throws before the snapshot and before anything is touched,
  naming the file and both sizes. New files pass at any size, small files pass
  at any ratio, and a normal edit — deleting a function, cutting a section —
  keeps far more than half and is unaffected. `29-write-guard` pins the
  thresholds **and** the two facts that make the guard necessary, so if the
  pipeline ever emits diffs instead, the reason this exists is still readable.
- **The Loops panel updates live in the browser.** `metisLoops.onChanged` is a
  real subscription now: the shim polls `metisLoops.list` every 10 seconds and
  fires the callback when the list actually changed, with the first poll
  recording rather than firing so a subscription starting is not reported as a
  change. Polling rather than SSE on this repo's own precedent — the phone page
  next door polls deliberately, because a loop's heartbeat is 60 seconds and
  polling survives a laptop sleeping and a network switch with no reconnect
  protocol. It also needs no new route and no widening of the `?token=`
  bootstrap, which `EventSource` would have forced since it cannot send an
  `Authorization` header.
- **The other four subscribe channels are recorded as unstreamable, with the
  reason.** They are `event.sender.send(...)` *replies* addressed to whoever
  invoked something, and every one of their producers is `decision` — starts a
  run, downloads gigabytes, spends money per keystroke pause, calls a model. A
  browser client cannot make those calls, so a stream for them would carry
  nothing forever. The plan for this slice was "an event stream so the 5
  subscribe channels stop being inert"; four of them are inert because their
  *producer* is forbidden, not because the transport is missing, and building
  the pipe anyway is the "surface that pretends to work" failure with extra
  steps. Now `noStream` in the manifest, guarded by name.
- **The browser client reads real data.** `POST /v1/bridge` serves 26 of the
  104 channels, allowlisted per member against the manifest, and
  `gatewayBridgeShim()` rebuilds `window.metisX` out of `fetch` so the renderer
  is not modified at all — it keeps calling `window.metisUsage.summary()` and
  neither knows nor cares that the call became HTTP. Conversations, models,
  loops, usage, providers, permissions and the audit log all load in a browser.
  The routes call the **same named functions the IPC handlers call**
  (`readConversations()`, `computeUsageSummary()`), so no IPC is involved and a
  browser read and a desktop read cannot disagree.
- **The shim tells "partly here" apart from "not here".** A namespace with at
  least one readable member is defined *in full*: readable members fetch, the
  rest reject with a message naming themselves. That is deliberate — the
  renderer guards on `Boolean(window.metisX)`, so defining a namespace makes
  every guard in it pass, and if the unreadable members were simply absent the
  guard would wave the code through and it would die on `undefined is not a
  function`. A rejecting promise is the honest version of "this needs the
  desktop app". A namespace with *nothing* readable is left undefined entirely,
  so its panels take the existing not-present path and render nothing rather
  than a row of errors.
- **The gateway serves the desktop renderer at `/app/`.** Not a second client
  and not a mock: the same Vite bundle Electron loads, from `dist/`, unchanged,
  so the browser can never drift from the desktop. `/app` without the trailing
  slash `301`s to `/app/` — Vite is `base: "./"`, so the relative asset paths
  resolve to `/assets/` otherwise and every one of them 404s behind a `200`.
  Assets go through the existing `serveStaticFile`, inheriting its `isPathInside`
  and realpath containment rather than a second hand-rolled check, and
  `mimeTypeFor` grew the extensions a real bundle actually emits (a stylesheet
  served as `octet-stream` is refused outright by strict MIME checking).
  `28-gateway-app-shell`, 60 assertions.
- **It renders. It does not work, and it says so.** Every component calls the
  Electron preload bridge directly, and over HTTP there is no preload, so all 31
  namespaces are `undefined` — no models, no conversations, nothing that sends.
  An inline classic script injected after `<head>` sets
  `window.__METIS_CLIENT__ = "browser"` before the deferred module bundle runs,
  and a strip on the page says plainly that it is not connected, so empty panels
  read as unfinished rather than broken.
- **The benchmark wizard is cut in the browser client, because it is the one
  surface that would lie rather than sit empty.** Its run is a `setInterval` over
  four hardcoded strings and its GPU table is a constant, so with no bridge
  behind it it completes *anyway*, unlocks the whole navigation, and recommends
  local models for a graphics card it never read. The first-run gate is unlocked
  in the same client — hiding the tab while the gate stayed armed would bounce
  every navigation to a tab that no longer renders, so the suite asserts both
  halves as a pair. Not satisfied, just not enforced by a wizard the browser
  cannot honestly run.
- **Every channel the renderer can reach is now classified.**
  `src/shared/bridge-manifest.ts` carries one entry per channel — namespace,
  method, kind, and an **exposure class** saying what it would mean to reach it
  from something that is not the desktop renderer: `read`, `write`, `reduce`,
  `decision`, `host`, `never`. `27-bridge-manifest` checks the table against the
  real preload and the real handler registrations, and fails the build on a
  channel that has no class.

  This is the groundwork for serving the app in a browser, and it exists because
  of what a survey of that idea turned up. The transport is nearly uniform — 93
  of 104 channels are thin `invoke` wrappers — but `installIpcSenderGuard`
  authenticates frame *topology*, and an HTTP caller has no `senderFrame`. No
  handler inherits any protection once reached over HTTP. So parity is
  re-exposing handlers as individually-authorized routes, which makes the
  exposed surface a 104-item decision — and a 104-item decision made from memory
  is one that goes wrong quietly. It already did once, one layer down, in the
  store-key guard below.

  Three facts the table pins that were not written down anywhere. The bridge is
  **103 members across 104 channels**: `metisSession.runStream` owns two,
  minting a correlation id in the preload and filtering a subscription on it,
  which is the least mechanical thing in the bridge and the one carrying run
  streaming. `metisProject.setConversationProject` owns a `metis-conversations:*`
  channel — the single cross-namespace pair, so a channel can never be derived
  from its namespace by convention. And `metis-loops:stop` and
  `metis-routines:run-now` resolve to `T | undefined`, which IPC transports and
  JSON does not.

  Nothing reads it at runtime yet, deliberately: the classification has to be
  right before anything is built on it.

- **`review x3` fans a step into three parallel instances that are not clones.**
  One written step becomes three run steps, named `review 1of3` upward, and each
  is told it is one of three working on the same material at the same time.

  `review & review & review` has always worked; three *identical* prompts is the
  waste. The debate literature the design note cites is blunt that N identical
  reviewers performs about like one reviewer at N times the price, and until now
  every member of a group got a byte-identical prompt with byte-identical
  context.

  **No invented angles.** The note says to give each instance a different angle,
  and that is where this stops following it. A chain step is free text: "check
  correctness / clarity / completeness" reads well against `review` and is
  nonsense against `research competitors`, and nothing in Metis can tell which
  it is. Putting invented subject matter into someone's step is the same failure
  as inventing a savings figure — it demos well and is silently wrong half the
  time. Each instance is told only true things instead: how many of you there
  are, which one you are, that the obvious first reading is covered, and that
  finding nothing the others would not is an acceptable answer. Three instances
  forced to differ will manufacture disagreement.

  Two corrections to the note, both in the doc now. Distinct names are **not**
  what fixes the completion match — `runLoopGroupTick` counts agents inside the
  group's time window rather than matching identities, so identical names always
  completed correctly. They matter because the panel, the audit log and the
  helper digest replayed into the next wake prompt all showed the same word
  three times, and a digest that cannot tell its own reviewers apart is one the
  next step cannot reason about. And the 9-helper ceiling **needed no decision**:
  9 ÷ 3 is 3 cycles, and a three-position chain reaches its group on turns 2, 5
  and 8, so the default turn cap runs out at the same moment. What was missing
  was that the number is invisible until you hit it, so the composer now says
  "3 in parallel · 3 cycles before the 9-helper allowance runs out".

- **Metis remembers your other conversations.** Alongside project files, a chat
  turn can now bring back what you worked out in a different thread, labelled
  as earlier and separate rather than folded in with the current exchange.

  The retrieval for this had existed since knowledge banks phase 2 — a local
  embeddings index over past conversations, reachable over IPC — and nothing
  called it. Its comment said "not wired into any prompt-assembly site yet",
  which reads as an oversight and turned out to be load-bearing: wiring it as
  written made the app **worse** in two independent ways, and both had to be
  fixed first.

  **The live thread was already in every prompt.** `recentConversationContext`
  puts up to 3000 characters of the current conversation into every chat call,
  so a search across all conversations retrieved that same thread back — paying
  an embedding round-trip to duplicate text the model was already reading, and
  spending its limited attention doing it. The current conversation is now
  excluded, which is also what makes this worth having at all: the value is the
  *other* threads.

  **The index invalidated on every turn.** Its signature counts each
  conversation's turn count and last-updated time, so finishing a turn changed
  it, and a miss re-embeds up to 200 chunks through Ollama. On the chat path
  that is a full re-index per message. A signature-stale cache is now reused for
  ten minutes — deliberate staleness, correct here and nowhere else in the app,
  because this index is only ever asked about *past* threads while the live one
  is injected verbatim regardless. An undated cache still rebuilds: "unknown
  age" must not mean "fresh forever".

  It is sized by the same per-reader policy as file retrieval, so a small local
  model gets one chunk over a strict floor and usually none — the design note's
  "behind the tier policy, not unconditionally" instruction, honoured rather
  than bolted on. And it is applied identically on the Oracle prewarm path,
  because that prompt is hashed byte-for-byte against the live one and a block
  on one side only would silently stop every exact-match serve. Suite 26 pins
  both call sites and that they prepend in the same order.

- **The models Metis installs for you can now be picked.** The Library gains a
  **Local** brand, and eleven models move into it: Llama 3.1 8B, Llama 4 Scout,
  Gemma 3 12B and 27B, Phi-4 and Phi-4 Mini, Mistral Small 24B, Moondream 2,
  LLaVA 13B, Nomic Embed Text and MxBai Embed Large.

  Every brand id in the picker named a *vendor* — qwen, claude, glm, deepseek —
  so a model with no vendor of its own could not be expressed as a `ModelRef` at
  all. All eleven were already in `LOCAL_MODELS` with real Ollama tags,
  recommended by the Benchmark and installable in one click, and then unpickable
  in the composer. A local-first app that installs a model for you and will not
  let you choose it.

  It is labelled **Local** rather than Ollama: the group holds models from six
  vendors, and you picked a model, not a runtime.

  Two fixes came with it. A locally-pulled model is now filed by reading its
  **tag**, so `qwen3:8b` shows under Qwen and `llama3.1:8b` shows under Local —
  before, everything from Ollama landed under Qwen, which was right for half of
  them and wrong for the rest, and the live catalogue made the wrong half real.
  And suite 25 enforces that every local Library entry resolves to an actual
  tag, because one that does not is *worse* than absent: `depthStageRefFor`
  returns null for it, so pinning it to a depth rung writes nothing while the
  level reads as configured. Ornith 1.0 35B has no tag and is deliberately left
  out for exactly that reason.

  The four models the design note originally wanted here (GPT-OSS 20B, Qwen3.5
  9B, Qwen3-Coder 30B, EmbeddingGemma) are still not added. A `LOCAL_MODELS` row
  carries VRAM, quantisation and tokens per second, and inventing those numbers
  to fill a table is the failure this catalogue work exists to prevent.

- **Every answer says which rung produced it**, as a small badge on each run's
  route line, and a "What each rung served" table lands in Settings > Usage:
  runs, tokens, and the turns promoted in or out of each rung.

  **Correction, 2026-08-16:** this first shipped saying "Settings > Usage adds
  a table" without noting that **Usage is one of the two settings sections v1
  deliberately hides**. The badge is reachable; the table is not, until that
  section is un-hidden. The check written to prevent exactly this asserted the
  panel *renders*, which passed — rendering is not reaching, and
  `12-doc-honesty` now resolves each panel to its section and compares against
  `V1_HIDDEN_SETTINGS`.

  `run.depth` had been recorded since Depths shipped and rendered **nowhere**.
  The ladder was invisible at exactly the moment it mattered — you could see
  which model answered and never which rung sent it there. The usage ledger
  carried no rung at all, so no lifetime rollup was derivable either; it records
  one now, for the same reason the attribution fields beside it were added
  early: rows written before a field exists can never be labelled
  retroactively.

  **There is no "you saved $X" figure, and that is the feature.** The design
  note proposed one, then corrected itself to "same turns at frontier pricing".
  Checking that correction, it does not survive either: *two* things differ when
  another model answers, the turn count and the tokens per turn, so pricing this
  run's exact tokens at another model's rate answers "what if a different model
  behaved identically to this one" — a question about nothing. And the
  arithmetic was never the real problem: the cheap rung's answer may simply have
  been worse, so money not spent is not money saved. The note under the table
  says so out loud, because a number that demos well is exactly the kind that
  gets added back later.

  Runs made with Depths off — the default — sit in a permanent **"Not
  recorded"** row rather than being folded into a rung that never ran. And the
  column worth having turned out to be **promoted**: the turns where a local
  rung blew its thinking budget and the router corrected itself. It is the only
  number in the ledger that measures routing being *wrong*, and a promoted run's
  tokens are billed to the rung that answered while the abandoned rung records
  only that it lost a turn — so the ladder's error rate is visible without
  inflating anyone's spend.

- **The two settings that had no screen now have one**, plus a third that
  never had one at all. Settings > Chat gains a **Knowledge banks** panel — the
  bank's own on/off, and how much to retrieve — and the **Experiments** panel
  gains the Depths thinking budget.

  `knowledgeBankEnabled` has been read by the main process since the day
  knowledge banks shipped and was documented as "on by default", with no
  control anywhere. `thinkTokenCeiling` and the retrieval postures shipped
  earlier the same day, both recorded in LIMITATIONS as having no UI. All three
  were settings only a text editor could change, which is the same failure in
  three places: logic with no screen to reach it.

  Every default is exactly what the main process already assumed, so opening
  Settings for the first time changes nothing. A control that alters behaviour
  on first render is a different change and would have been a worse one.

  Two decisions in the wording. The retrieval choices live in
  `shared/retrieval-policy.ts` beside the rule they describe, so a label cannot
  promise something `retrievalPlanFor` does not do. And **Full** is offered
  while saying plainly that on a model under 10B it re-enables the measured
  42–57% destruction of answers the model already knew — an override that hides
  what it costs is worse than no override.

  A new guard in `12-doc-honesty` pins all three keys as reachable and their
  defaults as matching main's, because "shipped but unreachable" is not
  something any other check in this repo could catch.

### Changed (2026-08-15)

- **Background work reaches the window now, instead of the window asking.**
  A settled loop turn pushes `metis-loops:changed` to every open window, so the
  conversation feed and the Loops panel both update on the beat it lands.

  Every main-to-renderer channel in this app was an `event.sender.send` — a
  reply inside an `invoke`, addressed to whoever asked. That works for streaming
  a run the user started and not at all for work that starts from a timer: a
  loop tick has no `invoke` to reply inside. So two surfaces polled, the feed
  every 20 seconds and the panel every 10, and the feed's poll shipped earlier
  the same day with a note in LIMITATIONS saying a real push channel was the
  better answer.

  It hangs off `mutateLoops`, the one choke point every loop write already
  passes through for the tray. One call site rather than one per writer, so a
  background path added later is covered by construction instead of by whoever
  adds it remembering.

  It carries **no payload**, which is the decision worth keeping. Loop records
  hold their whole history including per-step artifacts, so sending the list on
  every write would push tens of kilobytes through IPC to say "something moved".
  It is an invalidation signal; subscribers re-read through the `list()` they
  would have called anyway. That is also why the channel leaks nothing.

  Both subscribers keep a timer, for different reasons. The feed's runs only
  when the preload is too old to have `onChanged`, so a stale build degrades to
  the previous polling rather than to a feed that never updates. The panel's
  stays permanently: it also drives the relative-time display, and a dropped
  push must not leave a "running" badge on a loop that finished.

- **The `/loop` hint is inside the prompt box now, not stacked on top of it.**
  *"The recommendations for when you're using /loop or whatever should be
  inside the prompt box not above it."* It sits along the bottom of the input,
  with the textarea padded to clear it, so what you type flows above an
  annotation rather than under a banner.

  The interesting part is that its DOM position was never the problem — it was
  already inside the composer box. What made it read as a separate element
  stacked on the composer was that it had its own accent fill and its own
  border. Those are gone. The only separation left is a hairline rule, and it
  no longer takes clicks, because it is annotation rather than a control and
  swallowing a click there would put the caret nowhere.

  Not literal inline ghost text continuing your sentence: that needs a mirrored
  measurer to find the caret, and this hint is five labelled segments rather
  than one completion.

- **The knowledge bank now gives each model as much as it can actually use.**
  Retrieval used to hand every reader the same four chunks. It is now an amount
  chosen from the model about to read it: one chunk over a much stricter match
  floor under 10B, two chunks to 32B and for a local model whose tag does not
  state a size, and the existing four for anything larger and for every cloud
  model.

  This inverts the obvious plan. "Local models have small context, so retrieval
  matters more" is backwards — the problem is not that a 7B cannot *fit* a
  knowledge base, it is that a 7B cannot *use* what it retrieves. Handed a
  perfect oracle passage, a 7B extracted the right answer about 15% of the time
  on questions it did not already know, and adding retrieved context
  **destroyed 42–57% of answers it had previously got right unaided**. Net
  expected accuracy from deploying RAG at 7B: −2.9 points. `knowledgeBankEnabled`
  defaults to true, so the shipped default was a measured loss for exactly the
  reader Metis is proudest of routing to.

  Nobody else can build this, because everybody else has one model behind the
  curtain.

  Three decisions worth keeping. It keys on the **reader**, not on the Depths
  judgement — difficulty is a proxy at best for a model's ability to use
  retrieved text, and Depths is off by default, so a depth-keyed policy would
  have done nothing for most installs while the harm applied to all of them.
  Minimal is **one chunk, not zero**: nothing measured says retrieval is
  worthless at 7B, only that four loose chunks are worse than none, and zero
  would leave the knowledge bank silently inert on the tier Metis routes to
  most. And an **unknown size gets the middle** posture, because guessing rich
  on a hidden 7B reproduces the harm while guessing minimal on someone's 70B
  disables something that was working.

  When the amount is reduced the "Grounded on N chunks" row says why, so one
  chunk is never mistaken for a knowledge bank that has broken.

- **Depths can notice when it guessed wrong.** A turn routed to a local rung now
  carries a thinking budget. A model that spends the whole budget without
  starting an answer has its stream cut and the turn re-run one rung deeper,
  with a line in the timeline saying so.

  This is the only place routing corrects itself. Everything else in Metis that
  recovers — fallback chains, the critic loop, the loop judge — reacts to
  something that already failed. Routing had no failure signal at all:
  `pickDepthRung` judged a turn once, sent it, and never revisited, so a turn
  misjudged as trivial just produced a bad cheap answer and nothing anywhere
  noticed. A model that will not stop thinking is free information about
  difficulty, and it arrives *before* the answer is paid for.

  Four limits, none of them incidental. **Local only:** Ollama is the one
  provider whose reasoning Metis sees token by token, and a cloud model's
  thinking can only be measured after you have been billed for it. **Only while
  thinking is all it has produced:** once an answer has started the deliberation
  is over, and cutting the stream then would discard a real answer to punish a
  long preamble. **Once:** the retry carries no ceiling of its own, or one hard
  prompt walks the whole ladder paying for a call per rung, and a turn already
  on the deepest rung fails rather than re-running the same model to reproduce
  the same failure. And **no settings UI** — 1500 tokens, a deliberately
  generous runaway detector, adjustable only through the `thinkTokenCeiling`
  store key.

  A promoted turn says so where it matters: the timeline while it happens, the
  audit log, `depthPromotedFrom` on the run, and a `trivial → standard (L2),
  promoted` cell in the loop walkthrough's routing table. That cell is the one
  row where the router admits it was wrong, and reporting only the rung that
  answered would hide it.

- **A loop runs where you started it.** Type `/loop` in a conversation and its
  turns now land in that conversation, appearing as it finishes them. Before
  this they went into a hidden thread of the loop's own, so the loop existed in
  Settings, in the tray and on the phone page — everywhere except the place you
  started it.

  The shape follows what was actually asked for: *"it should be like I'm
  chatting with the model each time it's activated, except it's essentially
  working without a prompt."* So the reply is an ordinary run card, because it
  IS an ordinary turn, and where a user message would be there is a centred
  marker instead — `Loop turn 2 of 5 — fix what fails`. Not a bubble on either
  side. A bubble is the shape of somebody speaking and nobody spoke.

  What is deliberately never stored as your message is the wake prompt. That is
  the goal plus a digest of earlier turns plus the helper list plus the artifact
  plus the decision protocol — Metis writing to itself — and putting several
  hundred characters of it into the chat under your name would have
  misrepresented the run more than hiding it did.

  The fix underneath is small: a loop carries a conversation id from the moment
  it is created rather than inheriting whatever thread its first tick happened
  to mint. That is also why a loop started from an empty new session works —
  it gets a thread of its own, and the view moves there once the first turn
  lands.

  One honest edge: the feed re-reads on a 20-second timer while a live loop is
  attached to the open thread. Nothing pushes background work to the renderer,
  because every main-to-renderer channel in this app is a reply inside an
  `invoke` and a loop tick has no `invoke` to reply to. The poll is one small
  store read and only refetches the conversation when the loop's iteration count
  moves, but a real push channel is the better answer and is not built.

- **The model that did the work no longer decides whether the work is done.**
  A loop's continue-or-stop call used to go to whatever had just answered the
  work turn: the model that made the mistake voting on whether it was
  finished. It goes to the local rung now. Metis is the one product that does
  not have to pay for a second opinion — the local router is already resident
  and its tokens are free, where Claude Code spends Haiku tokens on exactly
  this check.

  Swapping the model reference would have been a rename. Three things make it
  a different check:

  The judge is **told it did not do the work**, because a model handed a
  first-person account of a task defaults to accepting it.

  The judge sees the turn's **evidence** — the exit codes and console errors
  the tick already collects — and not only the turn's prose about itself. "I
  have added the comments" is what a model writes whether or not it did. An
  exit code is not. That is the whole difference between an independent judge
  and a second opinion in the same voice.

  And it can answer **`BLOCKED`**, which finally has a precise definition:
  *what I was shown does not tell me either way*. It outranks `STOP` when a
  reply contains both — not for safety, since both halt the loop, but because
  a judge that said both has told you it could not tell, and filing that as a
  met goal is the one wrong answer that reads as success.

  The judge's **reason becomes the next turn's directive**. It is the only
  sentence in the loop written by something that looked at the goal and the
  evidence together, and until now it reached the panel, the tray and the
  phone page and never the model.

  Two honest edges, both visible rather than buried. With no local model
  reachable it falls back to the working model — a null decision ends the
  loop, and a self-judge beats no loop — and it records that it did rather
  than passing it off as independent. And a turn that answers inline with its
  own `metis-loop` block still grades itself; the judge runs on the fallback
  path, which is by construction the path every turn that does real work
  takes. Which model decided each turn is shown in the Loops panel and named
  in the walkthrough, because a behaviour change nobody can see is one nobody
  can check.

### Added (2026-08-15)

- **A step chain can name its outputs, and turn back on itself.**

  ```
  /loop --steps "plan -> draft as $draft -> review $draft as $notes -> revise $draft using $notes"
  /loop --steps "plan -> draft -> synthesise -> publish" --gate "synthesise fails -> draft" --gate-attempts 3
  ```

  The gate is the "Pass?" diamond from the flowchart this feature was designed
  against, and the first verdict in the grammar that decides **where** rather
  than only **whether**. `stepIndex` had exactly two writers and both did
  `(i + 1) % len`, so a chain could not express "if it fails, go back and try
  again" no matter what any model said. Now, after the named step runs, a model
  that did *not* do the work is asked PASS or FAIL, and a FAIL sends the counter
  backwards.

  Naming makes explicit what the handoff already carried positionally. A step
  could always see recent outputs, but only as "whatever came before", never as
  "the draft".

  Four rules that are the feature rather than details of it. **Silence falls
  through** — an unreadable verdict, an unreachable judge, or a spent attempt
  allowance all advance the chain normally, so a gated chain is never worse than
  an ungated one; guessing FAIL on silence would turn one flaky judge into an
  infinite retry. **FAIL wins an ambiguous verdict**, which is the opposite of
  the continue/stop rule and for the same reason: going back costs a turn, while
  a wrong PASS ships the failure. **The gate is capped** at five attempts,
  because a conditional edge with no ceiling is an infinite loop wearing a
  condition and this one runs unattended. And **`as $name` never reaches the
  model** — it is Metis's bookkeeping, and "draft the post as $draft" handed to
  a 7B is an invitation to write the literal `$draft` into the answer.

  A name used before anything declares it is refused in the composer, and so is
  a forward reference: a chain is a ring, so a later declaration would work on
  the second pass and not the first.

- **A finished loop writes down what it did.** When a loop settles it writes
  `walkthrough.md` into the folder it worked in: the routing trace first, then
  the files it wrote, then what actually got checked, then the verdict.

  The routing trace leads on purpose. Every agent that writes a run report can
  tell you which files it touched, and each of them reconstructs that report
  from its own tool calls afterwards. Metis has the difficulty the router
  judged, the model that served the turn and the tokens it used as typed
  records the instant the turn ends, so "turn 1 was judged trivial and ran
  local for nothing, turn 2 was judged deep and went to Opus 5 for twenty
  cents" is a read rather than an inference. That line is the product's whole
  argument, stated in evidence.

  It stays out of the way. Nothing in `plan` mode, nothing when the loop has no
  project folder, and it never overwrites a `walkthrough.md` it did not write —
  a foreign file gets a suffixed sibling, because an unattended loop clobbering
  a document is discovered late or never.

  Two things it refuses to round off: a turn on a model with no catalogue price
  is excluded from the total and counted in a footnote rather than summed in as
  zero, and helper turns are named but have no row, so the file says outright
  that its totals understate whenever helpers ran.

  The Usage tab's cost formatting moved into `shared/model-catalogue` on the
  way through, so the walkthrough and the Usage tab now render money through
  one function. `App.tsx` came out 18 lines shorter than it went in.

- **The model catalogue asks providers what they serve.** A refresh now
  fetches OpenRouter's `/api/v1/models` and Ollama's `/api/tags` from the
  main process and merges them over the bundled list, dropping anything past
  its provider-declared expiry. Both sources need no API key, each fails
  independently and silently, and the hardcoded list stays as the offline
  fallback.

  This closes the mechanism behind the worst bug in `1.2.0` rather than the
  bug itself: DeepSeek retired `deepseek-chat` and `deepseek-reasoner` on
  2026-07-24, Metis kept sending them from eleven call sites, and nothing in
  the app could notice because nothing ever asked a provider anything. The
  ids were corrected by hand on 2026-08-14; this is the part that means the
  next retirement does not need a person to spot it.

  One deliberate refusal, pinned in `18-model-catalogue`: an OpenRouter
  entry produces an OpenRouter route and never a synthesised direct one.
  Their ids are not safely invertible — dots where Anthropic uses dashes,
  dates dropped entirely, and `deepseek/deepseek-v4-flash` pointing at an
  older snapshot than DeepSeek's own — so inventing a first-party route from
  one would manufacture exactly the 404s this exists to prevent.

### Fixed (2026-08-14)

- **An SVG renders on what it contains, not on what the model called the
  fence.** Found in the first live use of `1.2.0`: Qwen3 8B answered a chart
  request with a correct, complete SVG and it printed as code, because the
  fence was labelled `xml` and the renderer tested the label. `svg`, `xml`,
  `html`, `markup` and a bare fence are all looked under now, and
  `isRenderableSvg` still decides — an `xml` fence holding real XML still
  prints as code. The exact Qwen output that failed is pinned in
  `15-svg-artifact`.

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
