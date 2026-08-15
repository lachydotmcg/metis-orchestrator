# What eight competitors are doing, and what Metis should take

Status: research, 2026-08-14. Eight products reviewed in depth (Google
Antigravity, Nous Hermes, OpenClaw, Claude Code, OpenAI Codex, Cursor,
Cline/Roo, and the LM Studio / Jan / Open WebUI local ecosystem), 57 findings,
then judged on three separate axes — identity fit, demo value, build cost — and
checked against this repo before ranking.

---

## The one thing worth knowing

**Eight products converged independently on the same conclusion: generation
stopped being the bottleneck and review became it.** Every mature agent tool now
ships a compressed, checkable *object* rather than a log — Antigravity's
walkthrough, Codex's review pane, Cursor's staged diffs, Claude Code's `/goal`
status.

Metis already records everything needed to print a strictly better version of
that object than any of them can, **because it is the only product in the set
where different models did different pieces of the work** — and it throws all of
it away when the run ends.

The second convergence is smaller and sharper. Five of the eight now separate
the model that judges "am I done" from the model that did the work, and every one
pays per token for that judge; Claude Code bills Haiku every turn. Metis has a
resident local judge and does not use it. `docs/LOOPS.md:239` says so outright:
`decideLoopContinuation` "reuses `followupInvokerFor` so the question goes to the
model that just did the work."

The model that made the mistake currently votes on whether the mistake is done.

---

## Checked against the repo before ranking

Four of the 57 findings were premised on gaps Metis does not have:

- **Screenshot verification is shipped.** `verifyPreviewInBrowser()`
  (`main.ts:4790`) already opens a hidden sandboxed `BrowserWindow` and writes a
  PNG; `AgentOperation` already carries `screenshotPath` and `consoleErrors`.
  What is missing is only that nothing durable points at the file.
- **`blocked` is already a real verdict and already reaches the phone.**
- **Mid-run steering already exists** as `sessionDirectives` /
  `takePendingDirectives`, drained between stages and addressable to a named
  fan-out agent.
- **The preference log is already collecting and deliberately unread** —
  per-run provider, model, pinned, depth, taskType, plus thumbs, capped at 5000.

And one structural gap **confirmed**: `grep -n "escalat" src/electron/main.ts`
returns nothing. `pickDepthRung` chooses a rung once, up front, and there is no
path back up the ladder.

**Depths is a guess with no correction.** That is the most important sentence in
this document.

---

## Shortlist

### 1. The loop walkthrough, whose real payload is the routing trace

At loop end, write `walkthrough.md` into the project folder: goal, a per-turn
table (difficulty judged, rung chosen, model, tokens, cost), files written with
their snapshot ids, evidence (exit codes, console errors, the screenshot already
captured), and the verdict with its reason.

Antigravity has to reconstruct this from tool calls. Metis has it as typed
records already. **The routing trace is the only line no competitor can print**,
so it belongs at the top of the file, not in a footnote.

A pure `formatWalkthrough(run, snapshot, ledgerRows): string` in `src/shared/`
plus one `writeFile` call site. Nothing added to `App.tsx`. A weekend.

**Built, 2026-08-15.** `src/shared/walkthrough.ts`, one call site in
`fireLoopTick` when the loop settles, and `19-walkthrough` in the offline suite.
`App.tsx` got 18 lines SHORTER: the Usage tab's cost formatting moved into
`shared/model-catalogue` so the walkthrough and the Usage tab render money
through one function instead of two that drift.

Three things the design above got wrong, found by building it:

- **The ledger was the wrong source.** It rolls off at 5000 rows and has never
  carried the judged depth — the one column that makes the trace worth
  printing. Routing is now captured onto the iteration record at the tick, not
  joined afterwards.
- **Snapshot ids are not reachable.** `writeGeneratedFileSet` sends its id to
  the audit log and the `lastProjectSnapshot` key and never onto the run, so
  there is no per-turn id to print. The file points at the revert control
  instead. Threading it is a separate change.
- **Helpers have no row and cannot have one.** A helper runs in its own
  conversation, so it is not a turn. It is named, and the file states that the
  totals understate whenever helpers ran, rather than presenting a total that
  looks complete.

### 2. Give the loop verdict to the local router, not the working model

Swap the invoker at `main.ts:11139` from `followupInvokerFor(...)` to the local
router, and keep the evaluator's *reason* as the next turn's directive. Add three
fields of a completion contract (`outcome`, `verification`, `stop_when`) drafted
locally from the goal, and `blocked` finally has a precise definition: *I could
not verify this from what I was shown.*

Claude Code pays Haiku tokens for exactly this check. Metis's judge is already
resident. Largest behavioural change per line touched anywhere in the repo.

**Built, 2026-08-15.** `loopJudgeInvoker` in main.ts, the prompt and the
`BLOCKED` verdict in `decideLoopContinuation`, the directive in
`composeWakePrompt`, and the provenance line in both the Loops panel and the
walkthrough. Suite 02 grew from 21 to 29 checks.

What the note above underrated, and what it missed:

- **The invoker swap alone would have been a regression.** A cloud-only user
  with no Ollama gets a placeholder from the local call, which returns null,
  which ends the loop — the exact "every working loop stops after one turn"
  failure `decideLoopContinuation` was written to fix. It falls back to the
  working model and *says so on the record*.
- **The completion contract was the wrong half to build first.** `outcome` /
  `verification` / `stop_when` drafted from the goal is a model drafting a
  standard for itself before any work exists. Handing the judge the turn's
  real EVIDENCE — the exit codes the tick already collects and already puts in
  the next wake prompt — is the same idea a step later and needed no new
  collection at all.
- **The reason was already being thrown away.** `lastReason` reached the panel,
  the tray and the phone page and never the model. The judge is the only thing
  in the loop that looks at the goal and the evidence together; its sentence is
  the most specific instruction available anywhere in the system.

**Still self-graded:** a turn that answers inline with its own `metis-loop`
block never reaches the judge. That is the low-stakes half — a turn doing real
work routes to the build pipeline, which cannot emit a block, so the judge
always runs on exactly the turns where self-grading was dangerous.

### 3. Think-token ceiling per rung, overrun promotes the turn

Cap thinking tokens on the local rung; when the stream crosses it, abort and
re-run at `depth + 1`.

This is the only mechanism in all 57 findings that turns routing from a
*prediction* into a *control loop with a cheap error signal* — and Metis is the
only product with a ladder to promote onto. Nous's own data says the dominant
failure of small local reasoning models is never stopping (Hermes 4 cut overlong
AIME generations from 28.2% to 6.1%), so the moment a model blows its budget is
free information about difficulty, available *before* you pay for the answer.

The plumbing exists: `invokeOllamaProviderStream` already parses `thought_delta`
and already accepts an `AbortSignal`.

**Built, 2026-08-15.** `src/shared/think-budget.ts` (the rule), a ceiling check
inside the Ollama stream reader, and a promotion branch at the chat path's
provider call. Suite 20.

Two corrections to the note above:

- **Not a flat cap.** The ceiling fires only while thinking is ALL the model has
  produced. A model that has started writing has finished deliberating, and
  killing it then discards a real answer to punish a long preamble. The overrun
  that carries information is the one where nothing is coming.
- **Not the `AbortSignal`.** That signal belongs to the user's Stop button, and
  reusing it would make a promotion indistinguishable from a cancellation at
  every catch site in the run path — where cancellation specifically means "do
  not retry". The reader is cancelled directly and a distinct
  `ThinkBudgetExceededError` is thrown, so the three outcomes that reach the
  same catch (stopped, provider died, overran) stay three.

It promotes once and the retry is uncapped: otherwise one hard prompt walks the
whole ladder, paying for a call per rung. A turn already on the deepest rung
fails rather than re-running the same model to reproduce the same failure.

### 4. The rung ledger, with an honest counterfactual

Badge each message with the rung that produced it; per-loop and lifetime totals.

**Two corrections that matter.** The counterfactual is not honest as stated — a
frontier model would not take the same number of turns. Label it "same turns at
frontier pricing" and show both counts, or a lab audience discounts the whole
ledger in one question.

And a real trap: pricing comes from `remoteModelCatalog`, fetched from a **second
repo you hand-update**, and the UI already degrades to `—` when a route has no
price. The headline number of your best demo depends on a JSON file that can go
stale silently. Bundle a local pricing table with a visible "prices as of DATE"
stamp, or fall back to token counts past N days.

### 5. Route chip in the composer

Show the router's judgement on the draft before send, one click to pin.

It is the only surface in the whole review that lets someone try to break the
router in five seconds at no cost, and adversarial testability is what a lab
audience wants.

**Landmine:** `decidePolicy()` shells out to a sibling repo and falls back to a
canned `sampleDecision` when absent. A chip rendering the canned fallback while
claiming to show live routing is the worst thing that could be on screen. Debounce
hard (it is a child process per call) and make the chip say when it is showing
the fallback.

### 6. Retrieval as a scoped tool the model calls

Add `grep` / `read-by-line` / `ls` over a knowledge bank root as a fourth agentic
tool, and make *which retrieval strategy you get* a rung decision.

Only fix for the acknowledged weakest component (flat cosine, top-4, 200-chunk
ceiling) that needs no new subsystem — `agentTools.ts` already owns path
containment and secret-path refusal and already has a suite. Open WebUI ships
BM25, cross-encoders and thirteen vector DBs, and their own troubleshooting page
tells capable models to use the filesystem interface instead.

### 7. Plan as a file, and per-file revert

(a) Make the Plan stage write `implementation_plan.md` through the snapshotted
write path and start execution from the file rather than the transcript. Cline
shipped this as `/deep-planning`; here it is close to a five-line change and cuts
loop token spend for free.

(b) `ProjectSnapshot.entries` already holds every original plus `createdByRun`.
Render them as a per-file keep/revert list **with a model-and-rung label per
file**. That gets the review surface and the routing proof without a diff engine.

### 8. Turn the preference log on

A read-side rollup over data already collecting: "you route frontend to Claude;
over your last N frontend turns DeepSeek won M of the head-to-heads."

The canvas currently asks you to *assert* that Claude does frontend well and
nothing has ever checked. Highest ceiling in the review, and the collection half
is already shipped and unused. Gate the UI behind a minimum n. Build the personal
half only — the community leaderboard is the part that needs a server.

### 9. Focus chain and blocked-with-options on the phone

A re-injected todo list per loop, and `blocked` emitting 2–4 tappable options
rather than free text. `UserQuestionRequest` already carries `options: string[]`;
the chat path has it, the loop path does not. Keep as the closer, not a pillar.

---

## Where the judges disagreed

- **Auxiliary calls pinned to local.** Two judges put it top-five. The third is
  right: `src/electron/followups.ts:1-17` documents that this was **already built
  and reversed**, because titling that always used the local model was one of two
  pieces of fakery the module replaced. Keep the picture — drawing internal calls
  as a labelled band on the canvas is a fine demo beat — drop the policy.
- **Hermes envelope harvesting.** The evidence that Ollama's OpenAI-compat shim
  leaks tool calls into `content` is **one third-party issue tracker**. Spend
  thirty minutes probing your own gateway with a complex multi-tool prompt before
  writing a parser. If local rungs do lose tool calls, every "14 turns handled
  locally" claim means "14 easy chat turns" and this jumps to the top. If not, do
  not build a parser against undocumented behaviour in someone else's shim.
- **Staged per-hunk diffs.** Priced at a month, and I agree. It inverts
  write-then-snapshot across every caller and needs a diff engine
  (`line-diff.ts` is 21 lines and documents itself as *not* a diff). The
  differentiating 5% is the model-and-rung label, which item 7b gets for a
  fraction of the cost.
- **Trajectory export.** Export alone is a hand-wave — everyone's logs are a
  potential dataset. Write it (a weekend, near-zero maintenance) but it only
  becomes a real claim with one before/after routing-accuracy number behind it.

---

## Do not build

- **Code Mode / WASM sandbox.** A VM, worker thread and host bridge in an app
  with six runtime dependencies, solving catalog bloat Metis does not have.
- **Git worktrees and handoff.** `projectSnapshot.ts` deliberately treats git as
  an optional layer 2 whose failure is ignored. The same sweep found Roo Code's
  git checkpoints silently disabled by nested repos, timing out on large ones,
  broken on Windows, one user losing an entire task history. Do not import the
  dependency you already refused.
- **Dreaming / overnight corpus maintenance.** Nothing to show, and six
  hand-picked weights invite one question with no good answer.
- **Hooks as a system.** The insight is right (a process returning exit 2 is
  deterministic where a rules file is not) but a hook system is developer
  extensibility, a bet on users the next milestone is not about. Hardcode two
  instead.
- **A permission matrix.** Codex has three sandbox modes crossed with three
  approval policies and the documented result is users reaching for
  `--dangerously-bypass-approvals-and-sandbox`. Take one finding instead: a
  mandatory one-line justification stored on the snapshot record.
- **Peer-machine canvas nodes.** Strategically the best reframe in the review —
  local-first means hardware you own, not this laptop — and tactically the most
  likely thing to fail live. Make it the v2 headline.
- **VRAM fit badges.** Hardware introspection on Windows without a native
  dependency means shelling out and guessing across drivers you will never test.
- **`.metis/knowledge/*.md` written by loops.** Self-pollution: the indexer scans
  the project folder, the loop writes learnings into the project folder, the next
  pass embeds its own output against a 200-chunk ceiling.
- **Anything with a server in it.** LM Studio's cloud tier, community
  leaderboards, hosted dashboards, push relays. Roo Code built a router, ran it,
  and switched it off on 15 May 2026, leaving 1.6M installs with evaporated
  routing. **That shutdown is the strongest available argument for Metis's
  positioning and belongs in the demo narration.**

---

## What Metis already does better

You are undervaluing four things.

1. **The snapshot layer is structurally sounder than Anthropic's and Cursor's.**
   Claude Code documents its checkpoints as lossy — files changed by bash are not
   tracked, most subagent edits are not restored. Cursor's forum carries "Restore
   Checkpoint permanently destroys change history". Roo Code's git version failed
   on nested repos, large repos and Windows. `projectSnapshot.ts` is 176 lines,
   not git-dependent, and the build pipeline is the single writer. Say
   "single-writer by design, so the snapshots are complete" and let the audience
   draw the comparison. Do **not** say "more complete than Claude Code's" in front
   of Anthropic engineers; the first question will be whether anything ever shells
   out.
2. **You shipped a first-class `blocked` verdict and surfaced it on a phone.**
   Google retrofitted notification badges in April 2026 specifically because
   pending permissions had been silent.
3. **Per-turn routing is demand the largest player has proven and left unmet.**
   Antigravity's own docs state there is no automatic routing and selection is
   sticky between messages. There is an open request on Google's forum with users
   writing your feature spec for you. Nobody in this set has it.
4. **Your engineering discipline is a differentiator, not an internal detail.**
   Six runtime dependencies. Seventeen suites over pure modules deliberately
   extracted so they exercise the shipped rule rather than a copy. Path
   containment with realpath and secret-path refusal. Compare against Antigravity
   wiping a user's D partition. That contrast is worth a slide.

---

## If you build one thing

**The walkthrough, with the routing trace at the top.**

Not because it is flashiest. Because it is a pure function in `src/shared/` that
drops straight into the offline suite, adds nothing to an 18k-line `App.tsx`,
invents no new state, and converts work the app **already does and already throws
away** into exactly what the next milestone asks for: something to show, that
survives the demo, that you can attach to an email.

It also sequences everything else. Once the file exists with empty sections,
every other shortlist item becomes "fill in a line of the walkthrough" — the
independent judge fills the verdict line, the think-budget ceiling fills the
escalation line, the ledger fills the cost line, the screenshot you already
capture fills the evidence line, the snapshot ids turn it into an undo manifest.
The first weekend is not wasted if the following ones go elsewhere.

---

## Evidence caveats

Carried rather than laundered: the Hermes/Ollama tool-call leak rests on a single
third-party issue tracker; Antigravity's directory layout comes from a community
handbook rather than Google's docs, and the claim that comments steer without
aborting could not be confirmed in Google's own documentation; LM Studio's fit-badge
wording comes from third-party write-ups; Hermes's "20+ self-created skills, 40%
faster" is vendor-internal with no published method; Roo Code's shutdown
announcement URL now redirects, so that quote is secondary reporting.
