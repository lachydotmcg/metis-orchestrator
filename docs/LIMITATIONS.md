# Known limits

Everything Metis does not do yet, or does in a narrower way than the name suggests. This lives
here rather than in the README so the README can describe the product, but nothing in this list is
hidden: each entry is linked from the honest-limits note inside its own README section.

Kept current on purpose. If something here gets fixed it is struck through with the date and the
commit, rather than deleted, so this file also reads as a record of what got closed and when.

## Loops

- **A loop runs alone.** Phase 2 (spawning parallel workers, waking when one finishes) is not
  built. A loop is one goal, worked one turn at a time.
- **No token ceiling.** Phase 3. The iteration cap (25) and wall-clock ceiling (12h) are still the
  only spend bounds. The prerequisite is now done: the ledger attributes each row to its loop and
  conversation, and `loopUsageTotals` sums it, so what remains is enforcing a limit rather than
  being able to measure one.
- **The capability check is a heuristic, and it warns rather than blocks.** It reads what models
  are AVAILABLE, since a loop routes through the Auto Router at each tick and the answering model
  is not knowable at creation. It cannot promise that a model above the ~7B bar will follow the
  protocol, only that nothing below it reliably does. Deliberately never refuses: Metis is
  local-first, and a gate that only passed metered cloud models would invert the product's own
  argument for the feature.
- **No tray presence for sleeping loops.** With headless start, the tray is the only surface, and a
  sleeping loop does not appear there yet. It is visible in Settings > Privacy & Data and pausable
  from the tray, but not listed there.

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

- **There are no automated tests in the repo.** Zero test or spec files under `src/`. The real
  gates are `npm run typecheck`, `npm run build`, and the CLI harness, which drives the actual
  pipeline headlessly. Several subsystems do have adversarial suites written against their compiled
  output (the loop decision layer at 41 assertions, the `/loop` grammar at 53, agent-tool
  containment at 8, path traversal, edit-intent routing at 14), but they live outside `src/` and
  are run by hand rather than by CI.
- **The manual walkthrough checklist is unticked.** It is kept privately rather than in the repo,
  but the consequence is public: it is why most README sections say `SHIPPED` rather than
  `VERIFIED`.
- **The Auto Router fix has not been proven in a packaged build.** It is in the live code path and
  it is what runs, but no recorded run backs it in a packaged installer yet. Given the original bug
  was "the router silently did nothing in every packaged build", that gap matters more here than
  anywhere else.
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
