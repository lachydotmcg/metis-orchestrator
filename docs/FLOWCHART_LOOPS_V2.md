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

### Built, 2026-08-15

Both halves. Grammar and validation in `src/shared/loop-command.ts`
(`stepVariableName`, `stepInstruction`, `stepVariableRefs`, `parseGateSpec`),
runtime in `src/electron/loops.ts` (`extractGateVerdict`, `gatePromptFor`,
`gateAppliesToTurn`, `nextStepIndex`), three persisted fields on `LoopRecord`
(`gate`, `gateUsed`, `variables`). Suite 22, 62 assertions.

Four things the note above did not say, three of them found by building it:

- **The declaration is stripped before the model sees the step.** "draft the
  post as $draft" handed to a 7B is an invitation to write the literal string
  `$draft` into the answer. `as $name` is Metis's bookkeeping, not part of the
  instruction, and `stepInstruction` is what the wake prompt and the gate judge
  both read.
- **A reference to an undeclared name is a parse error**, not a no-op, and it
  must be to an EARLIER position. A chain is a ring, so a forward reference
  would work on the second pass and not the first — the worst kind of
  intermittent. Group members cannot reference each other either: they run side
  by side and neither can see the other's output.
- **The gate resolves names to POSITIONS at parse time.** Storing text would let
  an edited chain silently repoint an edge at whatever step now carries those
  words, and a program counter pointed at the wrong place does not error — it
  quietly runs the wrong work forever. A group position cannot be gated at all,
  since it returns before any work turn and has no single output to judge.
- **FAIL wins an ambiguous verdict.** The opposite of `extractLoopDecision`'s
  rule, and for the same reason: going back costs a turn, while a wrong PASS
  ships the failure. Silence still falls through, so the safe default and the
  ambiguous default point in different directions here on purpose.

The "different model than the worker" is `loopJudgeInvoker`, which shipped for
the continue-or-stop call a few hours earlier — so the gate cost one call site
rather than the one-line change this note predicted, and inherits the
falls-back-to-the-worker-and-says-so behaviour with it.

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

### Built, 2026-08-16 — the fan-out half

`expandStepFanout` / `fanoutMemberPosition` in `shared/loop-command.ts`,
`parallelInstanceBrief` in `electron/loops.ts`, and a composer segment saying
how many cycles the allowance buys. Suite 22 grew from 62 to 83 checks.

**The cap needed no decision.** The arithmetic works out: 9 helpers ÷ 3 per
cycle = 3 cycles, and a `draft -> review x3 -> synthesise` chain reaches its
group on turns 2, 5 and 8 — so the default 8-turn cap runs out at the same time
the helper allowance does. Raising the ceiling would loosen an unattended-spend
guard to buy cycles the turn cap already refuses; making `--budget` mandatory
would tax a bounded three-helper group for a risk it does not carry. What was
actually missing was that the number is invisible until you hit it, so the
composer now says *"3 in parallel · 3 cycles before the 9-helper allowance runs
out"* before you press enter.

**Distinct names are not what fixes the completion match.** The note assumed
identical member names were ambiguous; they are not. `runLoopGroupTick` counts
agents started inside the group's time window rather than matching identities,
so `review & review & review` has always completed correctly. Names matter for a
different reason and it is worth being precise about which: the panel, the audit
log and the **helper digest replayed into the next wake prompt** all showed the
same word three times, and a digest that cannot tell its own reviewers apart is
one the next step cannot reason about.

**No invented angles.** The note says to give each instance a different angle,
and the debate literature it cites is right that N identical reviewers performs
like one at N× the price. But a chain step is free text: "check correctness /
clarity / completeness" reads well against `review` and is nonsense against
`research competitors`, and Metis has no way to classify which it is. Putting
invented subject matter into somebody's step is the same failure as inventing a
savings figure — it demos well and is silently wrong half the time. Each
instance is told only true things instead: how many of you there are, which one
you are, that the obvious first reading is already covered, and that finding
nothing the others would not is an acceptable answer. Forcing three instances to
differ manufactures disagreement.

**Not built: the AI writing the loop.** `draftLoopStepChain` still proposes the
narrower grammar it always did. Widening it is straightforward; the part that
is not is the confirm-before-run surface this note calls "the whole safety
story", and that is a real screen rather than a prompt edit.

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
