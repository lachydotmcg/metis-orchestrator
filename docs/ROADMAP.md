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

- **Loops phase 2: parallel workers.** A loop that can spawn helpers onto disjoint parts of a job
  and wake when one finishes, instead of a timer. The fan-out engine and the agent bus both already
  exist, off by default; this is wiring them to the loop rather than building them.
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
  intent, path containment and the line-diff counts — but they cover the adversarially-important
  slices, not the breadth of `src/`. The session pipeline, the build path and the renderer remain
  untested by machine.
- ~~**A packaged-build run of the Auto Router.**~~ Recorded 2026-07-21 (see docs/LIMITATIONS.md):
  an `electron-builder --dir` build answered `--cli chat` with a real metis-policy-cli decision and
  a routed provider reply. Still open in narrower form: the same proof against the actual NSIS
  installer output. (Packing note: winCodeSign needs symlink privileges Windows denies without
  admin/dev-mode — `--config.win.signAndEditExecutable=false` packs cleanly without it.)
- **Learned routing.** Metis already keeps a private local log of how you actually use it. Nothing
  reads it back into a routing decision yet, and doing so without making routing unpredictable is
  the hard part.
- **A run-command tool for agentic runs.** Deliberately last. It is the only tool whose blast
  radius is your whole machine rather than one folder.
