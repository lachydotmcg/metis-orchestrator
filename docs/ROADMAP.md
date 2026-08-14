# Roadmap

What is coming, roughly in the order it is likely to land. No dates: this is one person's
project and a date would be a guess dressed up as a promise. Anything already built and merely
hidden is marked, because "un-hide it" and "build it" are very different amounts of work.

### Next

- ~~**A spend ceiling for Loops.**~~ Shipped: `/loop --budget 200k` (and the CLI's `--budget`) sets
  a token ceiling summed from the ledger's per-loop attribution, checked before and after every
  turn, settling the loop at `exhausted` with both numbers in the reason. See docs/LOOPS.md.
- ~~**Sleeping loops in the tray.**~~ Shipped: live loops get their own tray section — status
  ("working now" / "wakes in 12m"), turn count, budget, and a Stop item that calls the same
  stopLoop the panel uses. The menu rebuilds on every loop write, and the one-line status says
  "idle, 2 loops waiting" instead of a flat "idle" while something is armed to spend money later.

### After that

- ~~**Loops phase 2: parallel workers.**~~ Phase 2A shipped: a "continue" decision can carry up to
  3 `spawn` helpers (9 per loop lifetime), each running as a loop-attributed session run — frozen
  permission mode, the loop's cancel scope, its own conversation, and spend that counts against
  `--budget` — and a finished helper wakes the sleeping loop immediately, with the 60s chain as the
  fallback heartbeat. Not yet recorded in a live run; still open: mid-flight worker reporting over
  the bus. See docs/LOOPS.md.
- ~~**Per-node Depths.**~~ Shipped for the pipeline: each depths-enabled node's L1-L3 stack now
  projects onto its own GraphPipelineStage, and the build/edit/fan-out paths judge the run's depth
  once and let every stage lead its chain with its OWN rung (prepended, so the normal chain stays
  the safety net; a pinned model still outranks it). The single global table remains only for
  plain chat turns, which have no per-node anything to consume.
- **Un-hiding the Marketplace** (built, `HIDDEN`). Browse, install and publish skills, MCP
  connections and orchestration presets. It works; it is held back because installing arbitrary
  packages is a trust surface and the registry behind it is early. Un-hiding waits on the registry
  having real content and on the install path getting a proper review.
- **Un-hiding the Manager** (built, `HIDDEN`). The README used to sell this as an agent that gets
  work moving while you are away. It is currently a todo board with a chat window, and it ships when
  that stops being true.
- **Un-hiding Routines** (built, `HIDDEN`), plus one-off scheduled wakeups. The scheduler already
  runs and already survives sleep and clock changes; it needs a `{ kind: "once" }` schedule and a
  visible surface that is not the hidden Routines view.
- **Un-hiding Gallery and Graph View** (both built, `HIDDEN`).

### From the first real use of v1.2.0 (Lachy, 2026-08-14)

He ran the app and used the features rather than reading about them. Everything
below came out of that, in his priority order.

- **Flowchart loops v2** — full graphs, variables, and describing a loop in English
  rather than learning a grammar. Designed in [`docs/FLOWCHART_LOOPS_V2.md`](FLOWCHART_LOOPS_V2.md).
  His words: *"I wanted to be able to design full on flowcharts like what I sent
  you, advanced ones with variables too, and even be able to ask the ai to do it
  for me by just telling it the kind of loop I want."* Three asks, buildable in
  three pieces; the first (named variables plus one conditional gate) is the one
  that makes the rest composable.

- **A running loop is invisible in the chat it came from.** This is the sharpest
  of the lot and it is a product bug rather than a missing feature. He started a
  loop from the composer, and the loop then ran with no trace in the conversation
  — it exists in Settings > Privacy & Data, in the tray, and on the phone page,
  but not where he started it. He expected: *"it should be like I'm chatting with
  the model each time it's activated, except it's essentially working without a
  prompt."*

  That is the right model and the current design fights it. A loop turn IS a
  conversation turn — it runs through `runSessionTracked`, produces a
  `SessionRun`, and appends to a conversation. It just appends to the loop's OWN
  conversation, invisible unless you go looking. Options, cheapest first: append
  loop turns to the conversation the loop was started from, marked as
  loop-authored so they read as "Metis working" rather than as replies; or keep
  the separate conversation but surface a live card in the originating thread
  that expands into it. The first is closer to what he described. Either way the
  composer's confirmation message ("watch or stop it in Settings > Privacy &
  Data") stops being the only breadcrumb.

- **Pairing the phone is two pieces of string, and should be one.** Today you
  copy a token out of Settings and construct
  `http://127.0.0.1:11500/?token=<token>` by hand. His note: *"you're giving me
  the access token and the localhost as separate pieces?"* Correct — it should be
  one scannable thing. A QR code in Settings encoding the whole URL, which is
  also the point at which a per-device token with its own revoke becomes worth
  building (see the pairing note in LIMITATIONS). Add a copy-the-link button for
  the case where the phone is not to hand.

- **The phone surface shows loops and nothing else.** *"Why not replicate Metis
  through there completely as it is as an application?"* The honest answer is
  scope rather than principle: watch-and-stop needed three routes wrapping
  functions that already shipped, and everything else needs new ones. Reaching
  full parity means the ~13 IPC handlers a phone client needs, an event fan-out
  hub with replay so a late-connecting phone catches up, and a pending-prompt
  registry so a question can be answered remotely — which is a permission grant
  made over a network, and a decision rather than a refactor. Worth writing up as
  its own staged plan before any of it is built. Note the desktop renderer cannot
  be reused: `App.tsx` is ~18k lines with one export and 284 direct calls to the
  Electron preload bridge across 29 namespaces.

- **Composer hints belong inside the prompt box, not above it.** *"The
  recommendations for when you're using /loop or whatever should be inside the
  prompt box not above it."* This is the same correction he made about
  suggestions earlier in the project's life, which is a sign the rule is general:
  guidance about what you are typing belongs where you are typing, as ghost text,
  not as a strip that pushes the composer around.

- **Memory and links, for a small-model reader** — designed in
  [`docs/MEMORY_AND_LINKS.md`](MEMORY_AND_LINKS.md). Lachy asked for memory optimised for
  Hermes-class local models and for Obsidian-style links that an LLM actually reads. Research
  inverted the obvious plan: at 7B and below, retrieval is net NEGATIVE (−2.9 points expected
  accuracy), a 7B uses a perfect oracle passage only ~15% of the time, and injected context
  destroys 42–57% of answers the model already knew. The bottleneck is utilization, not retrieval
  quality, so the lever is how little and how clean rather than how clever.

  The highest-value item falls out of architecture Metis already has: **Depths already judges how
  hard a turn is and picks the model — that same signal should govern how much retrieved context
  the model gets.** Rich for a frontier model, little or none for a local 8B. Nobody else can
  build it because everyone else has one reader. It also means `knowledgeBankEnabled`, which
  defaults to true, is a net loss when a small local model answers — it should be a per-tier
  policy rather than a global switch.

  Second finding, equally counterintuitive: default to one-hop PRE-EXPANSION rather than giving
  the model a follow-link tool. Small models measurably over-rely on whatever was retrieved first
  rather than retrieving again — they do not ask. A design whose correctness depends on a 7B
  choosing to call a tool fails quietly.
- **What eight competitors are doing** — reviewed in
  [`docs/COMPETITIVE_SWEEP.md`](COMPETITIVE_SWEEP.md). Antigravity, Hermes, OpenClaw, Claude Code,
  Codex, Cursor, Cline/Roo and the local-model ecosystem, judged on identity fit, demo value and
  build cost, then checked against this repo before ranking.

  The convergence is the finding: all eight now ship a compressed CHECKABLE OBJECT rather than a
  log, because generation stopped being the bottleneck and review became it. Metis records
  everything needed to print a better one than any of them — it is the only product in the set
  where different models did different pieces — and discards it when a run ends.

  One structural gap confirmed by grep rather than assumed: there is no escalation path anywhere.
  `pickDepthRung` chooses once, up front, and never revisits. **Depths is a guess with no
  correction.** The proposed fix is a think-token ceiling per rung whose overrun promotes the turn,
  which turns routing from a prediction into a control loop and is the only finding of 57 that
  does so.

  Also worth reading for the DO NOT BUILD list, which is as useful as the shortlist, and for four
  things the sweep says Metis already does better than the products reviewed.
### Wanted, not yet designed

- **Broader automated tests.** The repo now has offline suites (`npm test`, tests/suites/, run on
  every push by CI) covering the loop decision layer, the /loop grammar, permission clamping, edit
  intent, path containment, the store-mutation races, the line-diff counts, the per-node depth rung,
  the chain artifact channel and the doc markers themselves — but they cover the
  adversarially-important slices, not the breadth of `src/`. The session pipeline, the build path
  and the renderer remain untested by machine.
- **Running a loop without leaving the desktop on** (Lachy, 2026-07-26). The complaint is real: an
  overnight loop currently means an overnight PC. Researched, and the conclusion is that the
  obvious shape is the wrong one.

  The obvious shape is "put the project in OneDrive and let something in the cloud edit it". Do
  not build that. Sync clients are not transactional and OneDrive is documented, in Microsoft's
  own forums, to corrupt a `.git` folder once sync completes — and an agent writing forty files in
  ten seconds is close to the worst input a sync client can be given. The failure mode is a
  conflict copy per file and no way to tell which one the run meant. Every product in this space
  reached the same conclusion and uses git as the sync layer instead: Jules, Codex cloud, Copilot's
  coding agent, Cursor Cloud Agents and Claude Code on the web all clone a repo into a cloud
  sandbox and hand back a pull request rather than touching your disk. (For *documents* rather than
  repos the sync shape is fine, and OneDrive/Drive MCP connectors already do it — one writer, no
  dotfiles to corrupt.)

  A Metis cloud runner is also the wrong shape, for a product reason rather than a technical one.
  It would compete with those five on their own ground while giving up the sentence this README
  says three times: local-first, your keys, no server of ours in the path. The differentiator is
  not "an agent that runs while you sleep" — five companies sell that. It is "it runs on hardware
  you own, on models you chose".

  So the version worth building keeps the machine yours and only makes it cheaper to keep awake:

  1. **Wake-to-run.** Windows can wake a sleeping machine for a scheduled task. Headless start is
     already built and the loop scheduler is already written to survive sleep and clock changes, so
     this may be configuration rather than code. Cheapest thing to try, and it should be tried
     first because it might cost nothing.
  2. **A second small machine.** Metis headless on a mini PC or Pi, keys on your own hardware,
     Ollama serving the cheap rungs for free. Needs the loop store and conversations to be
     reachable from the desktop to see and stop a run, which is the actual design work: a loop must
     never be running with no surface that can stop it, and today that surface assumes one machine.
- ~~**A packaged-build run of the Auto Router.**~~ Recorded 2026-07-21 (see docs/LIMITATIONS.md):
  an `electron-builder --dir` build answered `--cli chat` with a real metis-policy-cli decision and
  a routed provider reply. Still open in narrower form: the same proof against the actual NSIS
  installer output. (Packing note: winCodeSign needs symlink privileges Windows denies without
  admin/dev-mode — `--config.win.signAndEditExecutable=false` packs cleanly without it.)
- **A document view with selection and comments** (Lachy, 2026-07-22). Open a file an agent is
  working on in a side panel, watch it change as the run edits it, select a passage and leave a
  comment on it. The comment is the interesting half: it turns "steer the whole run" into "steer
  THIS paragraph", which is a much sharper instruction than anything the composer can express
  today. Pieces that already exist: the `metis-files:read`/`write` IPC and its path guard, the
  Graph View doc panel, the right rail that already hosts the preview and side chats, and the
  directive bus that carries mid-run steering. What is missing is anchoring — a comment has to
  survive the agent rewriting the text under it, which is the same stale-range problem every
  review tool has, and the reason this is a design task rather than a wiring one.
- **A loop cannot check its own work** (found by dogfooding, 2026-08-05). The decision layer asks
  one question — continue or stop — and nothing observable feeds into it. A turn can already run
  `npm run test --if-present` as a conservative project command, but the result goes into the
  transcript, not into the next decision, so a loop cannot say "the tests fail, try again" or
  "the tests pass, move on". Every turn's judgement is the model reading its own prose about what
  it did.

  This is the difference between a loop that works overnight and one that DRIFTS overnight, and it
  is a bigger gap than the missing conditional edges — an unverified loop with branches just
  reaches the wrong step faster. It also overlaps the gate idea in the flowchart research: a gate
  needs a verdict, and a command's exit code is a far better verdict than a model's opinion of its
  own output.

  **Design note, 2026-08-06.** Written before implementing, because the shape of this decides
  whether unattended runs are trustworthy, and because reading the code changed what the fix is.

  *The evidence is not missing. It is collected and then thrown away.* `AgentOperation` already
  carries `status` (`complete` / `warning` / `error`), `exitCode`, `command`, `stdout`, `stderr`
  and `consoleErrors`, and every command a run executes produces one. `runSessionTracked` returns
  them on the `SessionRun`. `fireLoopTickInner` reads `run.assistantText` and
  `run.providerResult` from that same object and never looks at `run.operations`. So this is not a
  new subsystem: it is a field that already exists failing to reach a prompt that already exists.

  **Three faces, one channel.** Each was found separately and they are the same hole:

  1. *A loop cannot verify.* Evidence exists on the record and is discarded, per above.
  2. *A loop cannot ask.* Loop ticks call `runSessionTracked` with no stream, so
     `promptForPermission` returns `"deny"` and `promptUserQuestion` auto-answers the first option.
     A loop that needs a human is silently overruled rather than parked.
  3. *A loop cannot decline to act.* The decision layer asks continue-or-stop. There is no verdict
     for "I could not check this, so I am not going to guess", which is precisely the judgement an
     unattended run most needs. An agent that cannot distinguish *done* from *unverifiable* will
     always choose done.

  **The design.**

  *Evidence into the next turn.* Extend `LoopIterationRecord` with an `evidence` array derived
  from `run.operations`: kind, label, status, exit code, and a short tail of stderr when the status
  is not `complete`. Rendered into `composeWakePrompt` under its own heading, below the artifact
  and above the protocol block. The rule for what counts is deliberately narrow: **operations with
  an exit code**, plus browser checks that captured console errors. A file write is not evidence —
  it says something happened, not that it worked. Cap the stderr tail hard; the failing lines are
  at the end, so trim from the front, which is the opposite of the artifact's middle-trim and for
  the same reason (keep the part that carries the signal).

  *A third verdict.* The decision block gains `blocked`, alongside `continue` and `stop`. It
  settles the loop at a new `blocked` status with a reason, rather than stopping (which reads as
  success) or continuing (which burns turns on a wall). This is the smallest change that makes
  face 3 expressible, and it composes with the flowchart gate idea: a gate needs a verdict, and
  now there are three.

  *Asking is a separate, later phase.* It needs a stream threaded into loop ticks, plus a pending
  prompt registry — today `pendingPermissionPrompts` and `pendingUserQuestions` store only the
  resolver callback, never the request, so nothing can enumerate what is being asked. Note the
  surface now exists: the phone page added 2026-08-05 already polls loop state, and a pending
  question is the same shape as a Stop button. Do faces 1 and 3 first; they need no new plumbing.

  **What this deliberately does not do.** It does not let a loop decide which commands to run —
  that is the run-command tool, still last on this roadmap for the same reason. Evidence is read
  from operations the existing conservative runner already produced.
- **Learned routing.** Metis already keeps a private local log of how you actually use it. Nothing
  reads it back into a routing decision yet, and doing so without making routing unpredictable is
  the hard part.
- **A run-command tool for agentic runs.** Deliberately last. It is the only tool whose blast
  radius is your whole machine rather than one folder.
