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

Metis already has a channel for a model to propose structured actions: the `metis-actions` fenced
block, parsed out of a reply and permission-gated before anything happens (`ManagerAction`,
runtime-contracts.ts:187). Loops extend that channel rather than inventing a second one. Three new
action kinds:

```jsonc
{ "kind": "schedule_wakeup", "delaySeconds": 900, "prompt": "check the deploy again", "reason": "watching CI" }
{ "kind": "spawn_agent",     "name": "docs", "task": "update the README for the new flag", "reason": "parallel work" }
{ "kind": "stop_loop",       "reason": "the task is finished" }
```

Reusing the existing block buys the permission ceremony, the approval UI, the audit trail, and the
server-side re-validation for free. It also means a loop cannot do anything a Manager action could
not already do.

## The state record

A loop is a small durable object. Without it, a woken run is just a prompt with amnesia.

```ts
interface LoopRecord {
  id: string;
  goal: string;              // the original ask, verbatim, replayed every wakeup
  conversationId: string;    // where the loop's turns land, so history IS the memory
  projectPath?: string;
  status: "running" | "sleeping" | "stopped" | "exhausted";
  iterations: number;
  maxIterations: number;     // hard stop, default 25
  createdAt: string;
  nextWakeAt?: string;
  lastReason?: string;       // why it chose the current delay, shown in the UI
  spawnedAgents: { id: string; name: string; status: string }[];
  budget?: { tokenCeiling?: number; spentTokens: number };
  stopRequestedByUser?: boolean;
}
```

Stored under a `loops` key, list-shaped, same read/modify/write idiom as `routines`. Persisted
means a loop survives a restart, and the tick scheduler re-arms sleeping loops on launch exactly
as `startRoutineScheduler` already does for routines.

`conversationId` is the important field. The loop's memory is not a separate log, it is the
conversation itself, which already carries turns, runs, timings, and the knowledge-bank grounding.
Waking up is just adding a turn to a conversation that already knows what happened.

## The tick

1. A timer fires for the due loop (same slice-capped chain as `scheduleNextRoutineTick`, which
   already re-evaluates at least once a minute so a laptop sleeping through a wakeup is handled).
2. Metis composes the wake prompt: the goal, the iteration number, a compact digest of what the
   last iterations did, and the status of any spawned agents.
3. It runs a normal session turn in the loop's conversation, with the loop's permission mode.
4. It parses the reply's action block. `schedule_wakeup` sets `nextWakeAt` and re-arms.
   `stop_loop` ends it. No loop action at all also ends it, deliberately: **continuing is an
   explicit act, and silence stops the loop.** A loop that runs forever because a model forgot to
   say stop is the failure mode to design out first.
5. Every outcome writes an audit event, so the whole life of a loop is reconstructable.

## Waking on events, not just timers

The bit that makes Fable's loops feel alive is that a finished background worker wakes it
immediately, and the timer is only a fallback heartbeat. Metis can do the same with parts it has:
when a fan-out agent completes, it already posts to the `SessionDirective` bus. Loops subscribe to
that: a completion for an agent listed in `spawnedAgents` cancels the pending timer and ticks now.

That inverts the naive design from "poll every 60 seconds" to "sleep until something happens, with
a long fallback." It is also cheaper, which matters when every tick is a real model call.

## Governance, which is the part that decides whether this ships

An autonomous loop is the most dangerous feature in the app. It runs when nobody is watching. The
constraints are therefore not decoration.

- **Hard iteration cap.** Default 25, always set, never unbounded. `exhausted` is a real terminal
  status with its own honest UI copy.
- **Token budget.** This is where B12.7 pays off unexpectedly: the usage ledger and usage limits
  already meter every run. A loop takes a token ceiling and stops at `exhausted` when it is spent.
  The limits feature stops being display-only the moment loops exist, because a loop is the first
  thing in Metis that can spend money while the user is asleep.
- **Permission mode is inherited and can never escalate.** A loop created in `ask` mode wakes in
  `ask` mode, which in practice means it will block on the first gated action rather than proceed.
  That is correct. A loop must never be a permission laundering route.
- **Wall-clock ceiling** as well as iterations, because a loop with slow calls can burn a day in
  ten iterations.
- **Minimum delay.** Floor the model's requested `delaySeconds` (60s) so a confused model cannot
  spin a hot loop.
- **Nothing autonomous writes without CORE.5.** The git snapshot and path containment land before
  loops get file-writing tools, not after.

## Visibility and control

The rule from the taste sheet applies hardest here: honest UI, no fake buttons. If Metis is doing
something while the user is away, they must be able to see it and kill it in one click.

- An **Active loops** surface (the Routines view is the natural home, or a sibling tab) listing
  each loop with its goal, iteration count out of the cap, next wake time, its `lastReason`, and a
  Stop button.
- The **tray** already surfaces routing status and recent runs. A sleeping loop belongs there too,
  so a headless/tray-mode Metis is not silently working with no visible trace.
- Stop is immediate and unconditional: it cancels the timer, marks the record stopped, and lets any
  in-flight turn finish rather than tearing it apart mid-write.

## Phases

**Phase 1, the smallest thing that is genuinely a loop.** `LoopRecord` store, the tick chain,
`schedule_wakeup` and `stop_loop` actions, the iteration cap, and the Active loops list with Stop.
No spawning, no event wakeups. Testable end to end from the CLI harness (CORE.3):
`npm run cli -- loop "check the sandbox project builds" --max-iterations 3` and watch three ticks
happen and the loop terminate itself.

**Phase 2, workers.** `spawn_agent` wired to the existing fan-out engine, `spawnedAgents` tracking,
and bus-completion wakeups so the loop sleeps until a worker finishes.

**Phase 3, budget and polish.** Token ceilings drawn from the usage ledger, wall-clock ceilings,
tray presence, and loop templates the user can start with one click.

## Why this is worth building

Every other AI desktop app is a request/response box. A local-first app that can be handed a goal,
work on it in the background across hours, spawn helpers, and stop itself when done is a different
category of thing. And because Metis is local-first, the loop is the one place where free local
inference is not just cheaper but structurally enabling: nobody runs a 25-iteration autonomous loop
on a metered API for fun, but on your own hardware it costs electricity.

That is also the honest limit to respect. A loop is only as good as the model driving it. A 4B
local model will not reliably decide to stop. Phase 1 should gate loop-driving to capable models
and say so plainly rather than pretending every model can be trusted with the keys.
