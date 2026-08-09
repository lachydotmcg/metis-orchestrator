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
  own output. Pieces that already exist: the conservative command runner, `AgentOperation` records
  with status, and the decision block's parser. What is missing is a channel from an operation's
  outcome into the next turn's prompt, and a rule for which operations count.
- **Learned routing.** Metis already keeps a private local log of how you actually use it. Nothing
  reads it back into a routing decision yet, and doing so without making routing unpredictable is
  the hard part.
- **A run-command tool for agentic runs.** Deliberately last. It is the only tool whose blast
  radius is your whole machine rather than one folder.
