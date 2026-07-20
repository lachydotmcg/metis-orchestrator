# Flowchart Loops

**Status: PLANNED. Designed, not built. No code exists for this yet.**

Nothing in this document is runnable today. There is no `--steps` flag in the shipped parser, no step
state on a loop, and no step chain in any UI. This is the design note, written before the work, so the
shape is settled and the tradeoffs are on the record. If you came here looking for a feature to use,
use `/loop "<goal>"`, which is what ships now.

Status markers used across this repo's docs:

| Marker | Meaning |
| --- | --- |
| VERIFIED | ships in v1 and has a recorded run behind it, not just a green build |
| SHIPPED | ships in v1, reachable from the nav, works when driven by hand |
| FLAG OFF | built and wired, but the flag defaults to false |
| HIDDEN | built, code intact, not reachable from v1's navigation |
| PLANNED | designed, NOT built. No code exists. |

---

## What it is

A loop today is one goal. The model decides at the end of each turn whether to continue or stop.
That is the whole contract, and it works.

A flowchart loop is the same engine handed an ordered set of **steps** instead of a single goal. The
loop knows which step it is on. When it reaches the end of the chain, it starts again, because it is
a loop.

That is the entire feature. It is not a new subsystem, not a new view, and not a second kind of run.
It is a program counter on something that already runs.

## Syntax

The chain is text, typed into the same composer as any other slash command.

```
/loop --steps "read the project -> plan -> research & review -> implement -> document"
```

Three rules:

- `->` means **then**. The next step waits for the previous one.
- `&` means **at the same time**. It binds tighter than `->`, so `research & review` is a parallel
  pair and `implement` waits for both of them.
- The loop back to the start is **implicit**. You never draw it, because it is a loop.

Parentheses are optional, and exist for when a branch is more than one step deep:

```
/loop --steps "read -> plan -> (research -> write-research) & review -> implement"
```

Here `research` then `write-research` runs alongside `review`, and `implement` waits for the whole
group. Without the parentheses, `&` would only pair the two steps immediately either side of it.

**Conditionals are mostly not needed.** "Read project files if a project exists" does not want a
graph-level branch, because it is a perfectly good instruction *inside* a step, and the model already
handles that. A real conditional is only warranted if a step must be genuinely **skipped** rather
than turned into a no-op, and no example so far has needed that.

## Why text and not a canvas

This is the important decision, so here is the reasoning rather than the conclusion.

Metis already has an orchestration canvas, so the obvious move is to draw the step chain on it. That
would be wrong, because **the canvas is not a graph**. It is a model-binding table drawn as a picture.
Verified in the source:

- `GraphNode` in `src/renderer/ui/App.tsx` has no edge field. Nodes carry a position, a label, an
  intent, a provider, a model and a fallback chain. Nothing points at anything else.
- `projectGraphPipeline` orders the stages with `graphNodeOrderRank`, which is exactly two regexes
  over the node's label and intent text: planning-ish first, frontend-ish second, everything else
  after. The wires on screen are decoration and the projection reads none of them.
- Node positions are never read when building the pipeline. Where you put a node does not change what
  runs.

So a step graph on the canvas would mean writing **the first real graph interpreter in the app**:
an edge type, a topological sort, join semantics for `&`, per-node run state, and cycle guards. That
is a subsystem, and it would ship on the app's centrepiece with no automated test able to catch it
diverging from what actually executes.

A text chain needs none of it. It is a list. It parses in one pass, it diffs in git, it pastes into a
message, and a model can write one.

There is a second reason. The canvas has already trained users that wires are cosmetic. On a step
canvas they would be load-bearing. Same gesture, opposite meaning, nothing on screen telling you
which one you are looking at.

## Why not numbered levels

The first sketch of this was depth numbering:

```
1. Read   2. Research   2. Implement   3. Write
```

It breaks the moment the chain forks. With two steps at level 2, a step at level 3 cannot express
**which** level 2 step it follows. Depth tells you how far along you are, not what you came from.
Parentage is an edge, and numbering has no edges.

Naming the connection instead of the level solves it, which is what `->` and `&` do.

## What ships first, and what comes later

`&` needs parallel workers, which is Loops phase 2, which is not built. Sequential execution is what
the runtime can actually do today.

So the first version is **sequential only**. The parser will understand `&`, and reject it, with a
message saying parallel steps are coming rather than a syntax error that implies you typed it wrong.
Rejecting a token the docs describe is better than accepting it and quietly running the branches one
after another, which would look like it worked.

Later, once parallel workers exist, `&` starts running and the syntax does not change.

## The AI-authored path

Same syntax, no separate mode:

```
/loop --flowchart <goal>
```

A model is asked to propose a step chain from the injected project context. It hands back **the same
string** you would have typed. You read it, edit it like any other text, and run it. There is no
separate artifact, no generated diagram, and nothing that only the generator can produce.

This matters more than it looks. If generation emitted its own format, the hand-written path and the
generated path would drift apart. One syntax means the model's output is just a first draft of yours.

## Open questions

Honest ones, unresolved:

- **How does a step chain avoid steering the run?** Anything appended to a loop's wake prompt is a
  routing signal. A previous scaffold buried the goal and a read-only question routed to the build
  pipeline. A step list in the wake prompt is that same class of risk, and the mitigation (terse
  steps, placed below the goal, with a declared kind per step rather than inferred from verbs) is
  designed but unproven.
- **Are steps a contract or a hint?** A fixed chain deletes a real behaviour: a loop noticing that
  step 3 is pointless today. The current answer is that steps are a hint the model may skip, but that
  weakens the determinism that makes the feature worth having.
- **How long can a chain be?** The steps are replayed every wake, so a 12-step cycle costs more per
  turn than a 3-step one, forever. There is no token ceiling in the runtime yet, so this needs a hard
  budget rather than good intentions.
- **Does anyone actually hit the wall?** The case for this rests on loops wandering off their
  intended order. That is an observation from one user, not data. The test is whether a chain gets
  reordered in practice, or only reworded. If it is only ever reworded, this was a template, not a
  graph.
