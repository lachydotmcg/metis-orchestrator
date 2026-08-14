# Flowchart Loops v2: real graphs, variables, and loops the AI writes for you

Status: design, not built. Written 2026-08-14 from Lachy's feedback after using
v1 for the first time.

v1 shipped a **step cursor**: `--steps "plan -> draft -> review & review"`, a
flat ring walked one position at a time. The 2026-07-19 decision document argued
for exactly that and against building a graph interpreter, and it was right for
what was known then. What changed is that Lachy has now used it and said plainly
what he actually wanted:

> "I wanted to be able to design full on flowcharts like what I sent you, you
> know advanced ones with variables too, and even be able to ask the ai to do it
> for me by just telling it the kind of loop I want."

That is three separate asks. They are listed in the order they should be built,
which is not the order they were said.

---

## What v1 cannot express, precisely

Measured against the reference diagram Lachy sent — Task → Planner → Worker →
fan out to N Reviewers → Synthesise → "Pass?" → either back to Worker or on to a
post-processing step → Send to user, with a separate Plan Reviewer branch, and
with **resident** agents (persist across iterations) drawn differently from
**ephemeral** ones (fresh per invocation).

| Gap | v1 behaviour | Why it matters |
|---|---|---|
| **No conditional edge** | `stepIndex` advances `(i + 1) % len`, in exactly two places | The "Pass?" diamond is inexpressible. The only model verdict that steers anything is continue/stop/blocked, and it decides *whether*, never *where* |
| **No back-edge** | The ring wraps as a whole | "If it fails, go back to the Worker" needs a jump to position *k* |
| **No terminal** | The chain is a cycle by construction | "Send to user" as an absorbing state does not exist |
| **No branching** | One successor per position | Planner feeding both Worker and Plan Reviewer, rejoining at Synthesise, needs real edges. `parseStepChain` explicitly refuses parentheses |
| **No variables** | Nothing is named or carried except artifacts | A step cannot say "the draft", only "whatever the previous step produced" |
| **No role × N** | `review & review & review` is three literal strings, capped at 3 | There is no "one reviewer role, N instances" |
| **Residency is not declarable** | Green vs white is decided by whether you typed `&` | The distinction his diagram draws is an accident of syntax |

Two limits that will bite immediately: `LOOP_COMMAND_MAX_STEPS = 8` positions,
and `LOOP_MAX_SPAWNED_TOTAL = 9` helpers per loop lifetime — three reviewers
over three cycles exhausts the whole allowance, and `runLoopGroupTick` settles
the loop `exhausted` rather than degrading.

---

## Piece 1: variables, and the gate

The smallest change that makes the diagram's shape expressible, and the one that
should ship first because everything else composes with it.

**Named outputs.** A step may name what it produces, and a later step may
reference it:

```
/loop --steps "plan -> draft as $draft -> review $draft as $notes -> revise $draft using $notes"
```

Today a step sees the last three artifacts, labelled by the step that made them
(shipped 2026-08-06). That is positional and implicit. Naming makes it explicit,
and it is the prerequisite for a gate that tests something, and for a branch that
needs a particular earlier output rather than merely a recent one.

Implementation shape: `LoopRecord.variables: Record<string, string>`, written
when a step declares `as $name`, injected into the wake prompt only for the names
a step actually references. The existing artifact machinery already stores and
truncates the values — this is naming what it already carries.

**The gate.** One conditional edge, which is the whole right-hand side of the
diagram:

```
/loop --steps "plan -> draft -> review x3 -> synthesise -> publish"
      --gate "synthesise fails -> draft" --gate-attempts 3
```

After the named step runs, ask separately for a PASS/FAIL verdict — the same
shape `decideLoopContinuation` already uses when a work turn cannot carry a
decision. FAIL jumps `stepIndex` to the target. PASS falls through. **Silence
falls through**, which degrades exactly to today's behaviour and keeps the
governing rule intact.

Route the gate to a *different model than the worker*. Self-preference bias in
LLM judges is well documented, and this is a one-line change to the existing
`followupInvokerFor` choice.

Cost: roughly 300–400 lines, one new persisted field, no new subsystem.
`stepIndex` gains its third writer.

---

## Piece 2: role fan-out, and the AI writing the loop

**`x3` instead of three copies of a word.** `review x3` expands at creation into
three members with distinct names (`review 1of3`) so the completion match stays
unambiguous. Give each instance a different angle in its prompt — the debate
literature is blunt that N identical reviewers performs about like one reviewer
at N times the price.

This forces a decision on `LOOP_MAX_SPAWNED_TOTAL = 9`. Either raise it, or
derive it from `--turns × group size`, and make `--budget` mandatory when `xN` is
used.

**The AI writes the loop.** This is the ask most likely to be *used*, because
nobody wants to learn a grammar to try a feature once.

`draftLoopStepChain` already exists and already asks a model to propose a chain
from a goal — its prompt currently says "2 to 6 steps, no parentheses". The work
is to widen what it may propose as the grammar widens, and to surface it: you
describe the loop you want in English, Metis proposes the chain, **you see the
chain before it runs**, and you can edit it.

That last clause is the whole safety story. An AI-authored loop that runs
immediately is an autonomous run whose shape nobody reviewed. It should render as
a diagram — the same one the canvas already draws — with a confirm step.

---

## Piece 3: the graph, and resident agents

Only worth building once pieces 1 and 2 are in use, because they may turn out to
cover the real cases.

**Real edges.** Named nodes, explicit edges, guarded edges, a terminal. This is
what the 2026-07-19 doc refused, and its reasoning still deserves respect: it is
a subsystem, and more expressible graph means more specification surface to get
wrong. The MAST study of 1,600+ multi-agent traces found 42% of failures were
specification and system-design failures, not model failures.

The honest trigger for building it: when pieces 1 and 2 are shipped and a real
chain still cannot be expressed. Not before.

**Resident vs ephemeral.** His diagram distinguishes agents that persist across
iterations from ones spawned fresh and discarded. Metis already has both, both
implicit: the loop itself is resident (one conversation across every tick), and
helpers are ephemeral (own conversation, discarded). Declaring it — `@planner
plan -> @worker draft` — makes the distinction the user's choice rather than a
side effect of typing `&`.

Note the plumbing is half-built: `runLoopWorker` already records a
`conversationId` onto `LoopSpawnedAgent` and nothing ever reads it back.

**Where this must not go.** The canvas already has a display-only edge type
(`LabPipelineEdge`) that nothing reads to decide anything. Reusing that name for
a load-bearing edge would repeat the confusion the canvas already has, where
wires are cosmetic.

---

## What this does not include

- **Letting a loop choose which commands to run.** That is the run-command tool,
  still last on the roadmap. Evidence comes from operations the existing
  conservative runner already produces.
- **Parenthesised sub-chains.** `(research -> write) & review` needs per-branch
  program counters and drags resident agents in with it. Left as `PLANNED`.

## Sources consulted

LangGraph conditional edges and the `Send` API; CrewAI Flows `@router`/`@listen`;
AG2 nested chat and Magentic-One's task/progress ledgers; DSPy `Refine`;
Anthropic's multi-agent research system writeup; MAST (arXiv 2503.13657);
"LLMs Cannot Self-Correct Reasoning Yet" (arXiv 2310.01798); self-preference bias
in LLM-as-judge (arXiv 2410.21819).
