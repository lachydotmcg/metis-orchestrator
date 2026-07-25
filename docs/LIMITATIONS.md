# Known limits

Everything Metis does not do yet, or does in a narrower way than the name suggests. This lives
here rather than in the README so the README can describe the product, but nothing in this list is
hidden: each entry is linked from the honest-limits note inside its own README section.

Kept current on purpose. If something here gets fixed it is struck through with the date and the
commit, rather than deleted, so this file also reads as a record of what got closed and when.

## Loops

- ~~**A loop runs alone.**~~ Phase 2A shipped 2026-07-24 (`50ab730`): a continue decision can carry
  up to 3 `spawn` helpers, 9 per loop lifetime, and a finished helper wakes the sleeping loop.
- ~~**A helper is handed the step, and nothing else.**~~ Fixed 2026-07-25: a turn on a chain now
  records an artifact — its real output, code fences intact, unlike the history digest that
  replaces them with "(code)" — and the next position receives it, group members included. So the
  members of `draft -> review & review & review` are handed the draft. The artifact travels as
  `context`, never folded into the task, because routing classifies from prompt text and a draft
  full of code turns "review it" into a build.
- ~~**The helper digest is not scoped to the group that produced it.**~~ Fixed 2026-07-25: helpers
  launched as group members carry the group's `startedAt`, and the wake prompt shows the newest
  group whole plus any ungrouped helpers, rather than a flat lifetime tail.
- **An artifact is one hop, and only the last one.** A step sees what the step before it produced,
  not everything the chain has made. A synthesise step at the end of a long chain cannot reach
  back past its immediate predecessor, and two steps that both produce work hand only the later
  one forward.
- **A step chain is a ring with no branches.** `stepIndex` only ever advances `(i + 1) % len`, so
  there is no conditional edge, no jump to an earlier step, and no terminal step. A chain cannot
  express "if this fails, go back and try again", and the only verdict the model gets to steer with
  is the binary continue/stop.
- ~~**No token ceiling.**~~ Shipped 2026-07-24 (`0d48f27`): `/loop --budget 200k` sums the ledger's
  per-loop attribution before and after every turn and settles the loop at `exhausted` with both
  numbers in the reason.
- **The capability check is a heuristic, and it warns rather than blocks.** It reads what models
  are AVAILABLE, since a loop routes through the Auto Router at each tick and the answering model
  is not knowable at creation. It cannot promise that a model above the ~7B bar will follow the
  protocol, only that nothing below it reliably does. Deliberately never refuses: Metis is
  local-first, and a gate that only passed metered cloud models would invert the product's own
  argument for the feature.
- ~~**No tray presence for sleeping loops.**~~ Shipped 2026-07-24 (`5da4760`): live loops get their
  own tray section with status, turn count, budget and a Stop item, and the one-line status says
  "idle, 2 loops waiting" rather than a flat "idle" while something is armed to spend money later.

## Safety and recovery

- **Undo is one deep.** Only the most recent generated write can be reverted from Settings. Older
  snapshot folders still exist on disk with their manifests, but there is no history browser.
- **A revert never deletes files the run created.** Restoring content is safe and reversible;
  deleting a file you may have edited by hand since is not. Deliberate, and stated in the panel.
- **`plan` mode is a pipeline guarantee, not a sandbox.** It stops the build path before it can
  write and `gatePermission` defensively refuses anything that still reaches it. That is a strong
  read-only guarantee for the build path specifically, not OS-level isolation.
- **`gatePermission` is not the only code that touches disk.** The Graph View document viewer has
  its own read and write IPCs guarded separately by `assertMetisFilePathAllowed`. Path containment
  is consolidated; a single permission gate for the whole app is not a claim this repo makes.
- **Key encryption depends on the OS.** `safeStorage` where the platform provides it, base64 on
  disk where it does not. The app shows you which one is in use rather than implying encryption it
  does not have.

## Verification

- **CI now runs the offline suites on every push** (`.github/workflows`), 11 suites via
  `npm test`, covering the loop decision layer, the `/loop` grammar (including `--budget`), the
  permission clamp, path containment, edit-intent routing, the store-mutation race, the file-edit
  line-diff counts, the per-node depth rung rule and the chain artifact channel. They cover the
  adversarially-important slices, not the breadth of `src/`.
- **The manual walkthrough checklist is unticked.** It is kept privately rather than in the repo,
  but the consequence is public: it is why most README sections say `SHIPPED` rather than
  `VERIFIED`.
- ~~**The Auto Router fix has not been proven in a packaged build.**~~ Proven 2026-07-21: an
  `electron-builder --dir` build (`release/win-unpacked/Metis Orchestrator.exe --cli chat … --json`)
  produced a real `metis-policy-cli` decision — deterministic ruleset, full evidence and scores —
  and a real routed provider answer, end to end inside the packaged executable. The remaining
  narrower caveat: that run used the unpacked directory target, not the NSIS installer output,
  which shares the same asar/app layout but is not literally the installed artifact.
- **The `v1.0.0` tag predates almost everything described in the README.** It is all on `main` and
  is not yet tagged.

## Narrower than the name suggests

- **The Benchmark is simulated.** A hardware sizing guide, not measured inference.
- **Fan-out is sequential.** Named sub-agents with real file territories, executed one at a time.
- **Usage limits do not throttle.** Display-only, and the section is hidden in v1 anyway.
- **The router does not learn from you.** Metis keeps a private local log of how you actually use
  it and shows it back as plain-sentence observations. Nothing in it changes routing. It is a
  record, not a decision.
- **The Auto Router classifies by keyword rules plus a length rule**, not a learned model. The
  confidence numbers are fixed constants, so read them as a category label rather than a calibrated
  probability.

## Closed

- ~~**Five races in the loops store.**~~ Fixed 2026-07-19 (`63062be`): every mutation is now
  serialised and re-reads inside the lock, so a Stop clicked during a turn can no longer be
  overwritten by that turn's own final write. Also closed: two concurrent turns for one loop, the
  tray pause being checked once per pass, and the 60s timer being pushed out indefinitely by
  unrelated panel activity.

- ~~**Loops could only ever do one turn of real work.**~~ Fixed 2026-07-19 (`4222546`): a turn
  that routes to the build pipeline returns a pipeline summary rather than a model reply, so no
  decision block existed and the loop always stopped after one turn, having looked like it worked.
  The decision is now asked as a separate small call when the work turn cannot carry one. Verified:
  14 of 14 functions documented across 4 self-directed turns, stopping itself when the job was done.
- ~~**You cannot start a Loop from the app.**~~ Fixed 2026-07-19 (`62d49f5`): `/loop <goal>` with
  `--turns` and `--every`, plus a live hint strip in the composer.
- ~~**Stopping a run erases the answer you were reading.**~~ Fixed 2026-07-19 (`b979a50`): a stop
  is now its own state, keeps the streamed text, and reads neutral rather than as an error.
- ~~**The tray's pause did not cover loops.**~~ Fixed 2026-07-19 (`b979a50`): both scheduler chains
  honour it and the label says so.
- ~~**The composer's Stop killed background loops in the same folder.**~~ Fixed 2026-07-19
  (`81c9aee`): loops run in their own cancel scope.
- ~~**`agentToolsEnabled` had no UI and was developer-only.**~~ Fixed 2026-07-19: it is now a
  toggle in Settings > Chat > Experiments, with the containment and secret-denylist behaviour
  described in the copy.
- ~~**`doctor` claimed routing "falls back to a static sample".**~~ Fixed 2026-07-19: stale wording
  from before the built-in router existed, and it described the exact bug that had been fixed.
