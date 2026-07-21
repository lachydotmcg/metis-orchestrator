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
- **Per-node Depths.** Today a node's depth stack mirrors into one global route table, so with
  several depths-enabled nodes the last one projected wins. True per-node consumption inside the
  pipeline is the follow-up.
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
- **A packaged-build run of the Auto Router.** It is what runs, but the original bug was that it
  silently did nothing in a packaged build, so that specific proof matters more here than anywhere.
- **Learned routing.** Metis already keeps a private local log of how you actually use it. Nothing
  reads it back into a routing decision yet, and doing so without making routing unpredictable is
  the hard part.
- **A run-command tool for agentic runs.** Deliberately last. It is the only tool whose blast
  radius is your whole machine rather than one folder.
