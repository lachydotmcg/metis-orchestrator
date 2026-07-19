# Metis Loops: self-directed runs

Design doc. Written 2026-07-18 after Lachy asked for the thing he watches Fable do:
"you wake yourself up, spawn subagents, spend time checking on things, schedule yourself to wake
up again. I really want the infrastructure for that to be possible in Metis too."

## The honest starting position

Metis already has four of the five primitives this needs. It has been most of the way here for
weeks without anyone noticing, because the parts were built for other reasons.

| Primitive | What Fable uses | What Metis already has | Gap |
|---|---|---|---|
| A timer that fires a prompt later | ScheduleWakeup | `scheduleNextRoutineTick` / `fireRoutine` (main.ts ~9649), a self-rescheduling timer chain that already survives sleep and clock changes | The schedule is fixed by the user, not chosen by the model |
| Parallel workers | the Agent tool | the fan-out engine, `runFanoutPipeline` + `shouldAttemptFanout` (main.ts ~6756), off by default behind `fanoutEnabled` | Fan-out is decided by heuristics at the start of a build, not requested by a model mid-run |
| Workers talking back | task notifications | the agent bus, `SessionDirective` with kind steer/question/review_request/handoff | Nothing wakes a sleeping loop when a worker finishes |
| Durable memory across wakeups | the conversation transcript | `ConversationRecord` + the run history + knowledge banks | No record of "what loop am I in and what have I already tried" |
| **The model deciding to continue** | **ScheduleWakeup called as the last act of a turn** | **nothing** | **This is the whole gap** |

So this is not a from-scratch feature. It is one missing decision layer plus a state record,
wired into plumbing that already works.

## The missing primitive

At the end of every turn, Fable makes one choice: re-arm or stop. That single decision, made by
the model rather than by a cron expression, is what separates a loop from a routine.

> **This section is the ORIGINAL PROPOSAL and is not what shipped.** Kept because the reasoning is
> still worth reading, but see "Two decisions taken during phase 1" below for what replaced it and
> why. The short version: a loop tick never goes through the Manager chat, so `extractManagerActions`
> was not even in the path.

The original idea was to reuse the channel Metis already has for a model to propose structured
actions: the `metis-actions` fenced block, parsed out of a reply and permission-gated before
anything happens (`ManagerAction`, runtime-contracts.ts). Loops would extend that channel rather
than inventing a second one, with three new action kinds:

```jsonc
{ "kind": "schedule_wakeup", "delaySeconds": 900, "prompt": "check the deploy again", "reason": "watching CI" }
{ "kind": "spawn_agent",     "name": "docs", "task": "update the README for the new flag", "reason": "parallel work" }
{ "kind": "stop_loop",       "reason": "the task is finished" }
```

Reusing the existing block would have bought the permission ceremony, the approval UI, the audit
trail, and the server-side re-validation for free. What actually shipped is a dedicated
```metis-loop block (`extractLoopDecision`, loops.ts), which keeps the same SHAPE (fenced,
validated, never throws, silence is safe) without giving the Manager two actions it cannot perform.
`spawn_agent` was never built at all: that is phase 2.

## The state record

A loop is a small durable object. Without it, a woken run is just a prompt with amnesia.

This is the shape that actually shipped, copied from `src/electron/loops.ts`. Read that file for the
full reasoning comments, they are longer than the type.

```ts
export interface LoopRecord {
  id: string;
  goal: string;                  // the original ask, verbatim, replayed every wakeup
  conversationId?: string;       // optional: assigned by the first tick, not at creation
  projectPath?: string;
  origin: "app" | "cli";         // decides who may resume it after a restart
  permissionMode: string;        // frozen at creation, never re-read from settings
  fixedIntervalSeconds?: number; // "/loop --every 15m", overrides the GAP only
  status: "sleeping" | "running" | "stopped" | "exhausted" | "failed";
  iterations: number;
  maxIterations: number;         // default 8, ceiling 25
  createdAt: string;
  expiresAt: string;             // createdAt + LOOP_MAX_AGE_HOURS
  nextWakeAt?: string;
  lastReason?: string;           // why it chose the current delay, shown in the UI
  stoppedReason?: string;        // the honest closing line the panel shows when it is over
  history: LoopIterationRecord[];
}
```

Four things in the draft above this section did not survive contact with the build, and the doc used
to show them as if they had:

- **`spawnedAgents` does not exist.** That is phase 2 and nothing about it is built.
- **`budget` does not exist.** Token ceilings are phase 3 and nothing about them is built. Nothing
  in a loop reads the usage ledger today.
- **`stopRequestedByUser` does not exist.** A user stop sets `status: "stopped"` plus a
  `stoppedReason`, and `fireLoopTick` re-reads the record before its final write so a stop clicked
  mid-turn wins over whatever the model decided during that same turn. One field, not two.
- **`status` gained `"failed"`.** A turn that threw is not the same outcome as a loop that chose to
  stop, and collapsing the two would have hidden errors behind a word that reads like success.
  There is deliberately no retry: a loop that re-runs a failing turn every slice is the unattended
  runaway this whole feature exists to design out.

Four fields the draft did not have and the build needed: `origin`, `permissionMode`,
`fixedIntervalSeconds` and `expiresAt`. The first two are explained below, the third is the
`/loop --every` flag, the fourth is the wall-clock ceiling.

`history` is `LoopIterationRecord[]`: index, timestamp, a one-line summary of what that turn did,
the decision it made (`continue` / `stop` / `silent`) and any error. It is what gets replayed into
the next wake prompt, which is why the summary is capped at 240 characters: a verbose summary costs
tokens on every remaining iteration.

Stored under a `loops` key, list-shaped, same read/modify/write idiom as `routines`. Persisted
means a loop survives a restart, and `startLoopScheduler` re-arms sleeping loops on launch much as
`startRoutineScheduler` already does for routines, with two exceptions it learned the hard way: a
`cli` loop still sleeping is closed out rather than resumed, and an `app` loop left `running` is
marked `failed` rather than re-run, because Metis cannot know whether that interrupted turn had
already written something.

`conversationId` is the important field. The loop's memory is not a separate log, it is the
conversation itself, which already carries turns, runs, timings, and the knowledge-bank grounding.
Waking up is just adding a turn to a conversation that already knows what happened.

## The tick

1. A timer fires for the due loop (same slice-capped chain as `scheduleNextRoutineTick`, which
   already re-evaluates at least once a minute so a laptop sleeping through a wakeup is handled).
2. Metis composes the wake prompt: the goal FIRST and alone, then the iteration number and a
   compact digest of what the last iterations did. (No spawned-agent status: that was in the draft
   and phase 2 does not exist.) The goal leads because routing classifies chat-versus-build from
   the prompt text, and an earlier version that buried it under scaffolding got a read-only
   question routed as a build.
3. It runs a normal session turn in the loop's conversation, with the loop's frozen permission
   mode, passing the bare goal as `routingPrompt` so the protocol block cannot skew classification.
4. It parses the reply's ```metis-loop block. `"decision": "continue"` sets `nextWakeAt` and
   re-arms, `"decision": "stop"` ends it. No parseable block at all also ends it, deliberately:
   **continuing is an explicit act, and silence stops the loop.** A loop that runs forever because
   a model forgot to say stop is the failure mode to design out first.
5. Every outcome writes an audit event, so the whole life of a loop is reconstructable.

## Waking on events, not just timers (PHASE 2, NOT BUILT)

Nothing in this section exists yet. It is written in the present tense because it is the plan.

The bit that makes Fable's loops feel alive is that a finished background worker wakes it
immediately, and the timer is only a fallback heartbeat. Metis can do the same with parts it has:
when a fan-out agent completes, it already posts to the `SessionDirective` bus. Loops subscribe to
that: a completion for an agent listed in `spawnedAgents` cancels the pending timer and ticks now.

That inverts the naive design from "poll every 60 seconds" to "sleep until something happens, with
a long fallback." It is also cheaper, which matters when every tick is a real model call.

## Governance, which is the part that decides whether this ships

An autonomous loop is the most dangerous feature in the app. It runs when nobody is watching. The
constraints are therefore not decoration.

- **Hard iteration cap. SHIPPED.** `LOOP_MAX_ITERATIONS_CEILING = 25`, applied inside `createLoop`
  to whatever number actually arrives rather than trusted to have been clamped upstream. The
  default when a caller names nothing is 8, deliberately far under the ceiling: a loop that stops
  early and gets restarted is the cheap direction to be wrong in. `exhausted` is a real terminal
  status and the panel labels it "Hit its limit", never anything that reads like success.
- **Permission mode is inherited and can never escalate. SHIPPED.** Frozen onto the record at
  creation and never re-read, so changing the global while a loop sleeps cannot widen it. It is
  also clamped: the user's own setting is a ceiling, not a fallback, so a caller may ask for
  something tighter than the owner runs interactively but never something looser. That second half
  was added once `/loop` made this function reachable from the composer, because otherwise anything
  that could reach the IPC could start an unattended `bypass` run on a machine set to `ask`.
- **Wall-clock ceiling. SHIPPED IN PHASE 1, not phase 3 as this doc used to file it.**
  `LOOP_MAX_AGE_HOURS = 12`, stamped onto `expiresAt` at creation and checked by
  `loopTerminalReason` both before a turn is spent and again against the incremented record after
  it. Iterations alone do not bound a loop whose every turn is a slow build, so shipping the
  iteration cap without this one would have been a half-cap.
- **Minimum delay. SHIPPED.** `clampLoopDelay` floors the model's `delaySeconds` at 60 and caps it
  at 3600, so a confused model can neither spin a hot loop nor park itself past the horizon where
  the user has forgotten it exists.
- **Nothing autonomous writes without CORE.5. SHIPPED.** The snapshot and path containment landed
  first.
- **Token budget. NOT BUILT.** Still the phase 3 plan: the B12.7 usage ledger already meters every
  run, so a loop could take a token ceiling and stop at `exhausted` when it is spent. Today nothing
  in the loop path reads the ledger, and a loop's only cost bounds are iterations and wall clock.
- **Gating loop-driving to capable models. SHIPPED, as a warning rather than a block.**
  `assessLoopCapability` checks what models are AVAILABLE at creation, since a loop routes through
  the Auto Router at every tick and the answering model is not knowable up front. A cloud key or any
  local model at or above ~7B is silent; only smaller models get a warning naming the largest one
  you have and what will go wrong; nothing at all is reported as not capable. It deliberately never
  refuses, because Metis is local-first and a gate that only passed metered cloud models would
  invert this doc's own argument for the feature.

## The decision is asked separately when the work turn cannot carry it

A loop turn whose goal is real work routes to the build/edit pipeline, and that pipeline replies
with a summary of what it did rather than a model answer. There is nowhere in that reply for a
```metis-loop block to come from, so before this was handled EVERY loop that did real work ran exactly
one turn and stopped. That is the worst shape this feature could have: it looks like it works, and
quietly does a fraction of the job.

So the tick asks for the block first, since a plain chat turn answers inline and that costs nothing
extra, and falls back to a separate small call when there is none: the goal, what this turn
actually did, and how many turns remain, answered as a single line. `decideLoopContinuation` in
loops.ts. It reuses `followupInvokerFor` so the question goes to the model that just did the work.

This does not weaken the governing rule. The second call is a second chance to say continue, never
a default toward continuing: a failed call, an unparseable answer, or a placeholder result (Ollama
down, no key configured) all return null and the loop ends. An outage must never read as a reason
to keep spending.

It also matches what followups.ts already learned: small local models collapse when a single
response has to carry both a task and a piece of protocol. One job per call.

Proof run: "add a one-line JSDoc comment above each function in app.js, two per turn" ran four
turns over the sandbox, reporting "four functions still need comments", then "two functions
remain", then stopping itself with "every function now has a comment". 14 of 14 documented, file
still valid JS.

## Visibility and control

The rule from the taste sheet applies hardest here: honest UI, no fake buttons. If Metis is doing
something while the user is away, they must be able to see it and kill it in one click.

- An **Active loops** surface. SHIPPED as `ActiveLoopsPanel` in `src/renderer/ui/App.tsx`, listing
  each loop with its goal, iteration count out of the cap, next wake time, its `lastReason` or
  `stoppedReason`, a collapsed per-turn history of what it actually did, and a Stop button. It
  **lives in Settings > Privacy & Data**, not the Routines view the design assumed: CORE.7 hid
  Routines behind `V1_HIDDEN_NAV`, and a loop is the one thing in Metis that keeps working while
  nobody watches, so leaving its only surface behind a hidden nav item would have meant an
  autonomous run with no way to see or stop it. Privacy & Data is the honest home anyway, it
  already answers "what has Metis done to my files and how do I undo it".
- The panel **renders even when there is nothing to show**, explaining what a loop is and that
  `/loop` starts one. That is not decoration: the entry point is a typed command with no button
  anywhere, so an empty panel is the only place in the app that says loops exist.
- **Pausing.** The tray's "Pause background work (routines and loops)" covers loops too, and is
  named that way because it used to say "routines" while leaving loops running. `runLoopTick` checks
  `isRoutinesPaused` before firing anything. It is checked inside the tick rather than by declining
  to re-arm the chain, matching `runRoutineTick`, so unpausing takes effect within one slice. A
  paused loop keeps its `nextWakeAt` and resumes where it was.
- The **tray** does not yet list sleeping loops by name. Still phase 3.
- Stop is immediate and unconditional: it cancels the timer, marks the record stopped, and lets any
  in-flight turn finish rather than tearing it apart mid-write. `fireLoopTick` re-reads the record
  before its final write and honours a stop that landed during the run, so a click can never be
  silently overwritten by the model's decision from the same turn.

## Phases

**Phase 1, the smallest thing that is genuinely a loop. SHIPPED 2026-07-19, with one item still
open.** `LoopRecord` store, the tick chain, the continue/stop decision (as a `metis-loop` block, not
the ManagerAction kinds this doc first proposed), the iteration cap, the wall-clock ceiling, the
delay clamp, and the Active loops list with Stop. No spawning, no event wakeups. Testable end to end
from the CLI harness (CORE.3):
`npm run cli -- loop "check the sandbox project builds" --max-iterations 3` and watch three ticks
happen and the loop terminate itself. Startable from the app with `/loop <goal>` in the composer.
The capability warning ships too, see the governance list above.

**Phase 2, workers. NOT BUILT.** `spawn_agent` wired to the existing fan-out engine, `spawnedAgents`
tracking, and bus-completion wakeups so the loop sleeps until a worker finishes. None of this
exists: there is no `spawn_agent`, no `spawnedAgents` field, and nothing subscribes a loop to the
bus. The "waking on events, not just timers" section above is a plan, not a description.

**Phase 3, budget and polish. NOT BUILT,** minus one item that turned out to belong in phase 1.
Token ceilings drawn from the usage ledger, tray presence for sleeping loops, and loop templates the
user can start with one click. ~~Wall-clock ceilings~~: filed here originally, actually shipped in
phase 1 as `LOOP_MAX_AGE_HOURS`, because an iteration cap on its own does not bound a loop whose
every turn is slow.

## What actually shipped, verified by running it

Not "the code compiles". This is the run that proved the feature works, 2026-07-19.

The goal: **"count upward from 1, three new numbers each turn, stop at 9"**, with a cap of 5 turns.

- Iteration 1 produced 1, 2, 3 and asked to continue.
- Iteration 2 produced 4, 5, 6 and asked to continue. It did not restart at 1, which is the history
  digest in `composeWakePrompt` doing its job: without it a woken run is a prompt with amnesia.
- Iteration 3 produced 7, 8, 9 and **stopped itself**, at iteration 3 of a possible 5.

That single run demonstrates the four things worth demonstrating: history replay across wakeups, the
`metis-loop` decision protocol parsing correctly, self-termination BEFORE the cap rather than by
hitting it, and `nextWakeAt` being cleared so the scheduler does not re-fire a finished loop.
Stopping early is the important part. A loop that only ever stops because it ran out of iterations
has not shown that the decision layer works at all.

## Open items, honestly

- **Gating loop-driving to capable models. CLOSED 2026-07-19, with a caveat worth keeping.** The
  warning half shipped: `assessLoopCapability` reports at creation when nothing available is likely
  to drive a loop well, and a silent turn names the model that went silent. What it cannot do is
  promise the other direction. It reads availability, not the answering model, so "your 8B will
  probably cope" is not a guarantee, only "nothing below ~7B reliably does" is a real claim. Silence
  stopping the loop still means a weak model fails safe rather than dangerously.
- **The routing hazard the first live loop found.** Metis classifies chat-vs-build from prompt text,
  and an early, chattier version of the wake scaffold made a read-only goal ("how many functions
  does app.js define?") route to the BUILD pipeline, which rewrote the file from 171 lines down to
  10. Fixed two ways: `fireLoopTick` routes on `loop.goal` rather than the wake prompt, and
  `loopDecisionPromptBlock` is kept terse and free of words like build, make or create. Worth
  keeping in mind because it is a class of bug, not a single one: anything appended to a loop's
  prompt is a routing signal.
- **Token ceilings, worker spawning and event wakeups** all remain unbuilt, as above.

## Two decisions taken during phase 1 that changed the design above

Both re-checked against the shipped code on 2026-07-19 and both still accurate.

**The decision channel is its own block, not three new ManagerAction kinds.** The doc proposed
reusing `metis-actions`. Building it showed that a loop tick runs through `runSessionTracked`, so
`extractManagerActions` is not in the path at all, and a `schedule_wakeup` proposed by the Manager
would be an action with no loop to re-arm. Loops parse a dedicated ```metis-loop block instead
(`extractLoopDecision`, loops.ts). That keeps the SHAPE the doc actually cared about (fenced block,
validated, never throws, silence is safe) without handing the Manager two actions it cannot perform.

**A loop is resumed only by a surface that can also show it and stop it.** `LoopRecord` carries
`origin: "app" | "cli"`. The doc said sleeping loops re-arm on launch like routines do, which is
right for loops created in the app, because the Loops panel can show and kill them. It is wrong for
the CLI: kill `npm run cli -- loop` with Ctrl-C and the record is left sleeping with a future
wake time, so the next desktop launch would start an autonomous run the user never created and
would not think to look for. CLI-origin loops are therefore closed out on launch rather than
resumed, and the background tick skips them entirely so a foreground CLI loop can never be
double-fired into the same conversation.

## Why this is worth building

Every other AI desktop app is a request/response box. A local-first app that can be handed a goal,
work on it in the background across hours, spawn helpers, and stop itself when done is a different
category of thing. And because Metis is local-first, the loop is the one place where free local
inference is not just cheaper but structurally enabling: nobody runs a 25-iteration autonomous loop
on a metered API for fun, but on your own hardware it costs electricity.

That is also the honest limit to respect. A loop is only as good as the model driving it. A 4B
local model will not reliably decide to stop. Phase 1 was supposed to gate loop-driving to capable
models and say so plainly rather than pretending every model can be trusted with the keys. It does
not, yet. That gate is still open and it is the first thing left to close.
