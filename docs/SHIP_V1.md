# SHIP V1: the barebones plan

Written from a read-only audit of the codebase as it stood on 2026-07-18. `src/electron/main.ts`
(12,151 lines) and `src/renderer/ui/App.tsx` (16,777 lines) had other writers active on them during
this audit, so treat every file:line citation below as a snapshot, not a guarantee - if a line has
moved, the surrounding function name is the more durable anchor. Nothing in this document was
executed; it is static reading of the source, `docs/DRILL_PLAN.md`, and `docs/LIVE_TESTS.md`.

## The one-paragraph version

You were right to be scared, and you were right about why. The two things you named as core, a
router that picks the right model and an orchestration graph that drives builds, are genuinely
different in quality. The orchestration graph and its default build pipeline are real: they do not
depend on anything missing, they produce actual files, and the fallback chain is sound engineering.
The router is not real in any build you would ship. `decidePolicy()` silently falls back to a single
hardcoded canned decision whenever the sibling `metis-policy` repo is not present, which is true for
every packaged installer, because nothing in `electron-builder.yml` ships it. That is not a rough
edge, it is the headline feature not functioning as described. Fix that one thing before anything
else in this document matters.

---

## A. The cut list

Three buckets: **SHIP** (in v1, must be excellent), **HIDE** (code stays, nav/setting removed behind
a flag, cheap to bring back), **CUT** (delete it or leave it conspicuously, honestly unfinished).

### Nav views (11 total, enumerated from `NavKey` at `App.tsx:166` and the sidebar `<NavButton>` block
at `App.tsx:2973-2982`)

| View | Bucket | Why |
|---|---|---|
| **New session (chat)** | SHIP | This is the product. `session` is the only nav item that isn't gated by `benchmarkLocked` in spirit (it is in code, see Risk 4) and it's where the "type a prompt, get a great answer" promise lives or dies. |
| **Orchestration** | SHIP | The second core pillar. The canvas, Library, and default 3-stage build pipeline (`defaultAgenticStages`, `main.ts:5488-5504`) work independently of the broken policy bridge, wired to real cloud/local fallback chains. This is the most genuinely finished major surface in the app. |
| **Manager** | HIDE | README sells it as an agent that "gets work moving while you are away." The code's own comment disagrees: `App.tsx:14474-14479` - "v1 Manager suggestion actions are all local: mutating the shared todoBoard store and in-app navigation, never a model or API call... deeper ones (auto-triage, drafting replies, running commands) must route through the existing permission ceremony." It's a todo board with a chat window bolted on, not an autonomous worker yet. |
| **Marketplace** | HIDE | Installs arbitrary skills/MCP servers/presets from a separate, thin registry repo. Real security work went into it (SHA-256 verification before install, `main.ts:2313`), but it's a large trust surface for a feature that isn't core, and the registry it depends on is early. |
| **Routines** | HIDE | Scheduled automation is a "later" feature by the owner's own framing. Dry-run (I9.4) is marked NEEDS-LIVE-TEST. Nothing here is broken, it's just not core. |
| **Gallery** | HIDE | You already made this call once: `docs/DRILL_PLAN.md` B8.1 - "Metis Gallery is HELD BACK from the stack until the Gallery gets more work." Consistent to hold it back from v1 nav too. Needs a vision model pulled as extra setup, which is more onboarding friction for a non-core feature. |
| **Graph View** (memory graph, `MemoryGraphWorkspace`) | HIDE | Genuinely cool, genuinely peripheral. Its main value (knowledge provenance, I9.7) is already visible inline in chat via the "Grounded on N chunks" row, so hiding this tab loses little. |
| **To Do List** | HIDE | A generic kanban board. Mostly exists to support Manager, which is also hidden. No differentiation. |
| **Benchmark** | PARTIAL | Onboarding steps 1-2 (name, preference) ship as-is. Step 3 ("hardware check") needs an honesty pass before v1, see Risk 3. The standalone Benchmark tab (reachable later from the sidebar's More group) can stay reachable post-onboarding, it's cheap and low-risk once step 3 is fixed. |
| **Community (Pulse)** | HIDE | Depends on a remote feed from `metis-registry` that's early, so most users see "Nothing new yet" (`App.tsx:2748`, an honest empty state, but an empty room is still an empty room). Also ships a dead-end fallback: `pulse.discordInvite ?? "https://discord.gg/"` at `App.tsx:2829`, Discord's generic landing page, not an actual invite. Hide until there's real content and a real link. |
| **Settings** | SHIP | Required. Individual sections triaged below. |

**Hide mechanism (one mechanism, reused for every HIDE item above):** add one module-level constant
next to `PALETTE_VIEWS` (`App.tsx:172`):

```ts
// v1 ship scope. Remove a key from this set to bring that view back for a future release.
const V1_HIDDEN_NAV = new Set<NavKey>(["manager", "marketplace", "routines", "gallery", "graph", "todo", "pulse"]);
```

Then filter three call sites through it: `PALETTE_VIEWS` (command palette results, `App.tsx:2583`),
the sidebar's `<NavButton>` list (`App.tsx:2973-2982`), and `selectNav`'s guard (`App.tsx:1965-1972`,
alongside the existing `benchmarkGateLocked` check, so a deep link or a stale bookmark can't reach a
hidden view either). Nothing else changes: every component, IPC handler, and store key stays exactly
as it is. Un-hiding a view later is deleting a string from one `Set`.

### Settings sections (9 total, `SETTINGS_NAV` at `App.tsx:14506-14516`)

| Section | Bucket | Why |
|---|---|---|
| General | SHIP | Holds the Policy bridge status panel (`App.tsx:15187-15218`), which becomes *more* important post-fix, not less. Also permissions and the registry link. |
| Providers | SHIP | The BYO-keys story is real and core to "no lock-in." |
| Appearance | SHIP | Cheap, already polished (the interface-sound work alone has a 100+ line test checklist in `LIVE_TESTS.md` section 17). |
| Chat | SHIP | Route ceremony, streaming, custom instructions. Directly supports core chat. Keep the Experiments sub-panel visible but see the flags note below. |
| Privacy & Data | SHIP | Cheap, trust-building, no dependencies. |
| Audit | SHIP | Cheap, and genuinely useful for you debugging a v1 user's bad report. |
| About | SHIP | Cheap. Fix the version number honesty issue (Risk 7) while you're in there. |
| MCP servers | HIDE | Spawns arbitrary local stdio processes for installed servers. Real trust surface, and P10.2 (MCP tools mid-run) is explicitly NEEDS-LIVE-TEST. Hide the tab from `SETTINGS_NAV`; the `mcpToolsEnabled` flag already defaults off underneath it. |
| Usage | HIDE | Well-built and honestly labeled ("display-only... nothing throttles yet" is stated in the UI copy itself), but it's polish on top of core chat, not core chat. The ring specifically is NEEDS-LIVE-TEST. Bring it back once verified; it costs you nothing sitting hidden since it's a read-only report over data you're already collecting. |

**Hide mechanism:** identical pattern, a `V1_HIDDEN_SETTINGS = new Set<SettingsSection>(["mcp",
"usage"])` filtering `SETTINGS_NAV` before it renders.

### Experimental flags (already hidden, zero work required)

`prewarmEnabled`, `oracleCloudEnabled`, `oracleSimilarityEnabled`, `mcpToolsEnabled`,
`modelDrivenRoutingEnabled`, `depthRoutingEnabled`, `fanoutEnabled`, `quickAskEnabled`,
`headlessStart` all default to `false` (confirmed in `docs/ARCHITECTURE.md`'s store table and spot
checked at `main.ts:6779` for `fanoutEnabled`, `main.ts:8885` for `depthRoutingEnabled`). This is
already the correct v1 state. **Do nothing to the code.** The only action item is promotional
discipline: none of these should appear in v1 marketing copy (README, landing page, demo script)
until each one has an actual checkmark in `LIVE_TESTS.md`, put there by a human running the real
Electron app. Right now the README's feature tour describes several of these (managed agents,
Depths, Cloud Oracle) as if they're ambient, on-by-default capabilities. They are not; they're
inert unless a user finds Settings > Chat > Experiments.

### CUT (delete or leave conspicuously unfinished)

- **The account menu's "Log out" item** (`App.tsx:3304-3307`, disabled, `title="Coming soon"`). This
  is a local-first app with no account system at all; "Log out" implies one exists. Delete the menu
  item rather than promise a feature that contradicts the product's own pitch.
- **The account menu's "Language" item** (`App.tsx:3276-3280`) can stay; it's an honest disabled stub
  for a plausible future feature and doesn't imply something false about the app's architecture.
- **`https://discord.gg/` as a Discord fallback URL** (`App.tsx:2829`). Moot immediately since Pulse
  is hidden for v1, but fix it before Pulse ever comes back: fall back to hiding the tile, not to a
  fake-looking link.
- **The "1.0.0" version framing.** Not code, but cut the illusion: `package.json:3` says
  `"version": "1.0.0"` while `CHANGELOG.md:5` says "This is the project's first tagged release" and
  `docs/RELEASING.md:21`'s own example walks through `0.1.0 -> 0.1.1`. Ship the real first public
  release as `0.1.0` (or `1.0.0-beta.1`). Calling a first release with 31 NEEDS-LIVE-TEST items and a
  non-functional headline feature "1.0.0" oversells it before a single user has opened it.
- **The word "Benchmark" and the fake progress animation in onboarding step 3.** See Risk 3. Rename
  and de-theater rather than polish; there's nothing real to show a progress bar for yet.

---

## B. The v1 quality bar

Testable statements, not vibes. A build that can honestly check every box here is safe to promote.

1. A fresh install, with only Ollama running and one model pulled (any model, not specifically
   `qwen3:8b`), can complete onboarding and get a real answer to a plain chat message with zero
   manual configuration beyond picking that one model during install.
2. No chat run's assistant bubble ever reads "The route completed, but no live model answer was
   returned" while a specific, actionable reason (Ollama down, model not pulled, key missing, a
   named provider error) exists in the run's data and is simply not being shown.
3. Auto Router either (a) genuinely classifies the prompt using something running on the user's own
   machine, no external sibling repo required, or (b) is honestly relabeled in the composer and route
   ceremony as a default/fallback model choice, not presented as adaptive routing, until (a) ships.
4. Every progress indicator, checklist, or "checking..." animation the user can see in the v1 build
   represents work that is actually happening. None simulate a measurement that isn't real.
5. Every nav item left visible in v1 has at least one clean end-to-end run-through by a human in the
   real Electron app, logged as a checked box in `docs/LIVE_TESTS.md`. "It compiled" is not "it works."
6. Every HIDE-bucket nav item and settings section is unreachable from the sidebar, the Ctrl+K
   command palette, and direct nav-key state, not just removed from one visible list.
7. Pinning a specific model and sending a message never silently fails; it either answers or shows
   the specific reason in the main chat bubble, not buried at `warnings[1]` behind an unrelated
   `warnings[0]`.
8. The build pipeline (point at a folder, ask for something) produces working files or a specific,
   named reason it didn't, for both a user with cloud keys configured and a pure-local user with none.
9. The version number in Settings > About matches the build's actual maturity, and the README's
   feature tour only describes what's on by default or one toggle away and verified, not everything
   that compiled during the 48-hour drill.
10. Stop button, permission prompts, and file-write gating (the safety-critical trio for "let it work
    on my folder unattended") have each been exercised at least once by a human against a real project
    folder, not just code-reviewed.

---

## C. Top 10 risks, ranked

### 1. Auto Router is non-functional in every packaged build

`decidePolicy()` (`main.ts:3189-3249`) calls `getPolicyStatus()`, which looks for a `metis-policy` CLI
and profile at `policyCliCandidates()`/`policyProfileCandidates()` (`main.ts:3123-3145`). These paths
only ever resolve to a sibling directory (`../metis-policy/dist/src/cli.js`) or an env var
(`METIS_POLICY_CLI`). `electron-builder.yml:12-16` packages only `dist-electron/**/*`, `dist/**/*`,
and `package.json`; `metis-policy` is never bundled, and no onboarding step, settings panel, or IPC
handler anywhere in the renderer lets a user import a leaderboard payload to satisfy it (confirmed by
grep, zero matches for any "import leaderboard" UI surface). So for every installed copy of the app
that isn't literally your own dev machine, `decidePolicy()` falls through to
`src/shared/sample-decision.ts`, a single hardcoded object: `task_type: "summarisation"`,
`selected_route: { model: "qwen3:8b" }`, a canned "reason" citing benchmark numbers that were never
measured on that user's machine, dated 2026-06-28. This decision is called unconditionally for every
non-pinned, non-cached chat turn (`main.ts:8464-8469`) and its `route.model` flows straight into the
actual provider call with no existence check (`main.ts:8896-8897`). `applySessionRouteOverrides`
(`main.ts:3539-3571`) only ever changes the outcome for two narrow regex triggers (explicit "Claude"
mention for frontend, explicit "coding pipeline" phrase); every other prompt gets the identical canned
model regardless of content.

**Fix:** either vendor a real, lightweight classifier directly into `main.ts` (no child-process spawn
to a sibling repo that will never exist on a user's machine), or ship a bundled default
`policy-profile.json` as an `extraResource` and inline the CLI's decision logic. Until one of those
ships, do not describe Auto Router as adaptive in any promotional copy.

### 2. When the fallback model isn't installed, the genuinely useful error message gets thrown away

`invokeProvider`'s Ollama branch generates a specific, actionable message on failure:
*"Ollama is not running, or {model} is not pulled. Start Ollama..., then run: ollama pull {model}, and
send again"* (`main.ts:1009-1015`). But `buildAssistantText` (`main.ts:4572-4583`) discards it:
`const output = providerResult?.source !== "placeholder" ? providerResult?.output.trim() : "";` sets
`output` to an empty string whenever the source is `"placeholder"`, then falls through to the generic
*"The route completed, but no live model answer was returned."* The good message survives only by
being pushed into `run.warnings` (`main.ts:9241`), and the render layer only ever shows
`warnings[0]` (`App.tsx:7296`, `7313`, `7342`, all three `CompletedRun` branches do this). When Risk 1
is also in play, `warnings[0]` is usually the unrelated *"metis-policy CLI was not found. Build or
configure METIS_POLICY_CLI..."* line (`main.ts:3161`), a developer-facing message about an environment
variable, shown to a brand-new user, while the actually-useful line never renders anywhere in the UI.

**Fix:** in `buildAssistantText`, when `providerResult.source === "placeholder"`, return
`providerResult.output` directly instead of discarding it. It already *is* the answer to show.

### 3. Onboarding's mandatory "hardware check" is theater, not measurement

`BenchmarkWorkspace` (`App.tsx:10519` onward) has no hardware detection anywhere in the codebase
(confirmed by grep: no `systeminformation`, no `os.totalmem`, no GPU query in `main.ts`). The user
manually picks a GPU from a six-entry dropdown (`GPUS`, `App.tsx:863-870`: RTX 3060/4070/4080/4090, M3
Max, CPU-only, nothing else, no AMD, no Intel, no older or newer NVIDIA cards) defaulting to
`"rtx3060"` (`App.tsx:10531`). The "check" itself is a `setInterval` incrementing a progress bar 14%
every 480ms (`App.tsx:10536-10549`) through a checklist whose third label is the literal string
`"Simulated decode/VRAM capture"` (`App.tsx:10534`). Recommended models' speed is a static per-model
number (`LOCAL_MODELS[].tps`) rendered as `~{model.tps} tok/s` (`App.tsx:10869`), never measured on the
user's actual hardware. This is the mandatory first thing every new user does, before they can send a
single chat message, and it's presented as more authoritative than it is.

**Fix for v1 (cheap):** rename the step away from "Benchmark" (try "Pick your hardware"), delete the
fake timed progress animation, and change "Simulated decode/VRAM capture" to something that doesn't
imply measurement happened. **Fast-follow:** real detection via Node's `os.totalmem()` plus a
platform GPU query (`nvidia-smi` on Windows/Linux if present, `system_profiler` on macOS), falling back
to the manual picker only when detection fails.

### 4. The entire app is gated behind that onboarding wizard, with no skip

`activeNav` starts at `"benchmark"` (`App.tsx:1714`). `benchmarkGateLocked` (`App.tsx:1891`) is true
until `wizard.status === "complete"`, and `selectNav`/`startNewSession` (`App.tsx:1955-1972`) redirect
back to the wizard for every other nav key, including `"session"` itself, while it's locked. Every
`<NavButton>` in the sidebar carries `disabled={benchmarkLocked}` (`App.tsx:2973-2982`), including the
New Session button (`App.tsx:2962-2963`). Combined with Risk 3, a user who just wants to try chat is
forced through five wizard steps, including a real multi-gigabyte model download, before they can type
a single message, with no visible way to skip.

**Fix:** add an honest "skip for now" escape hatch to reach chat, even if it means a degraded
first message (a clear "no local model yet, add a cloud key or pull one" prompt) rather than a wall.

### 5. The most-marketed "team of agents" feature is off by default and its core claim is unverified

The README's Managed Agents section promises agents that "talk to each other over a shared bus with
handoffs, questions, and review requests, so two agents editing the same project stay in sync." The
engine is real code, but `fanoutEnabled` defaults to `false` (`main.ts:6779`), and
`docs/DRILL_PLAN.md`'s own Phase 5 entry says agent-to-agent messaging (5b) is "NEEDS LIVE TEST for
live inter-agent traffic" while the render layer for it (5c thread-render) is listed as a follow-up,
not done. Nobody has watched two agents actually hand off or review each other's work in the real app.

**Fix:** either live-test it for real (this is the single highest-leverage verification task on the
whole list, since it's the second-most-marketed feature after Oracle) before any v1 promotion mentions
it, or drop it from v1 copy entirely and revisit once verified.

### 6. Auto Router's only honest disclosure is buried in Settings, disconnected from actual chat

The Policy bridge panel (`App.tsx:15187-15218`) correctly shows "Needs setup" / a "fallback" status
pill and the real detail text when `metis-policy` is unavailable, but it only updates when a user
manually clicks "Test route" in Settings > General. The live chat route ceremony
(`main.ts:8932-8938`) shows generic "I'm checking the route and preparing the selected model" with no
health check against the same status, so a user experiencing Risk 1 gets zero in-context explanation
of what actually happened.

**Fix:** when `decidePolicy` returns `source: "sample"`, either quietly prefer the user's last-pinned
model instead of theatrically "routing" to a canned answer, or surface a one-time, honest banner in
the composer: "Auto Router isn't fully set up yet, calling {model} directly. Pin a model in the
meantime for a guaranteed-reliable chat."

### 7. Versioning oversells maturity

Covered in the cut list. `package.json:3` says `1.0.0` for a build whose CHANGELOG admits it's the
first tagged release, with 31 items marked NEEDS-LIVE-TEST in `docs/DRILL_PLAN.md` alone and a
headline feature (Risk 1) that doesn't function as described. Cheap fix, real trust cost if skipped.

### 8. Thirty-one shipped features have never been touched by a human in the real app

`docs/DRILL_PLAN.md` contains 31 literal "NEEDS-LIVE-TEST" markers; `docs/LIVE_TESTS.md` is a
330-line, 17-section walkthrough written specifically because "everything here shipped green on
`npm run build` but has never been touched in the real Electron app" (its own opening line). This
covers the per-model gateway rework, Depths, Cloud Oracle, Oracle near-match serving, MCP tools mid-run,
headless mode, routine dry-run, conversation forking, the build pipeline's warm-chain, knowledge
provenance, the Usage tab and ring, custom instructions interacting with Oracle's hash-match serving,
quick-ask, Metis-as-MCP-server, learned-router signals, per-conversation project folders, and the
entire interface-sound system.

**Fix:** this is pure verification labor, zero design work. Before promoting any specific feature from
this list publicly, run its section of `LIVE_TESTS.md` once. It's the fastest points-per-hour item on
this whole document.

### 9. Manager markets autonomy it doesn't have yet

Already covered in the cut list; repeated here because it's a promotion risk, not just a scoping one.
If Manager ships visible in v1 with README-level "gets work moving while you are away" copy, a user
will try to test exactly that claim and find a todo board.

### 10. Community/Pulse ships a dead-end link a curious new user will click

`App.tsx:2829`: `pulse.discordInvite ?? "https://discord.gg/"`. A generic Discord landing page instead
of an actual invite is a cheap, needless bad-first-impression risk on a tab most new users will
explore out of curiosity. Moot once Pulse is hidden per the cut list; flag it for whenever it returns.

---

## D. First-run narrative: a new user's first five minutes

**0:00** - App launches. `activeNav` starts at `"benchmark"` (`App.tsx:1714`); every other nav
button, including New Session, is disabled with the tooltip "Finish the benchmark wizard first"
(`App.tsx:2962-2963`). There is no way to reach chat yet.

**0:10** - Step 1, Welcome: enter a name. Cheap, honest, works.

**0:30** - Step 2, Preference: Local, Cloud, or Hybrid. Cheap, honest, works.

**0:50** - Step 3, "Hardware check": manually pick a GPU from six options (Risk 3). A ~3.4 second
scripted progress animation plays through four labels, one of which literally says "Simulated
decode/VRAM capture." Nothing was measured. The user has no way to know this unless they read that
label closely and know to be suspicious of it.

**1:10** - Step 4, Install: one-click pull of the recommended local models. This part is real (genuine
Ollama pull progress events, `App.tsx:10603-10613`). Depending on the picks and connection speed, this
is a multi-gigabyte download taking anywhere from thirty seconds to several minutes; the user is now
waiting on a real download disguised as a continuation of the same onboarding flow that just faked a
progress bar one step earlier.

**~2:00-5:00** - Step 5, Keys: offer to add a cloud API key, skippable. User skips, BYO/local default
kicks in. Onboarding completes.

**On completion** - the wizard's `onComplete` lands the user in **Orchestration**
(`App.tsx:2099`: `onComplete={() => setActiveNav("orchestration")}`), a blank node-graph canvas, not
chat. A user who came here to talk to something is looking at a pipeline editor.

**First message** - user clicks New Session, types a question, hits send. If the model they installed
in step 4 isn't literally `qwen3:8b` (a real possibility: the recommendation engine may have pointed a
modest GPU at a smaller model, or the user already had a different model pulled from before), Auto
Router (Risk 1) unconditionally requests `qwen3:8b` anyway. Ollama returns not-found. Nothing streams
into the chat window (the failure throws before any token is emitted, `main.ts:1128-1129`). The run
"completes" and the assistant bubble reads **"The route completed, but no live model answer was
returned."** with a small grey line underneath reading **"metis-policy CLI was not found. Build or
configure METIS_POLICY_CLI to enable real decisions."** The one message that would have actually told
this user what to do (`ollama pull qwen3:8b`) was generated by the backend and never shown (Risk 2).

**This is where the story breaks.** A first-time user with a perfectly correctly-installed local model
that simply isn't the one hardcoded into the sample decision gets a confusing, jargon-laden dead end on
their very first message. The honest workaround exists and works well (pin the model they actually
installed, in the composer's model picker, which bypasses the whole broken path per PF3), but nothing
in the onboarding flow tells them to do that, and nothing in the failure message points them there
either.

---

## E. What to promote (the honest pitch)

What's genuinely strong, verified by reading the code, not the README:

- **Free, local, and yours.** `usageCostLabel` (`App.tsx:14565-14572`) honestly returns "Free" for
  every Ollama row, no metering, no phone-home. `providerInfo`/`metisSecrets` confirm the BYO-keys
  story is real: your keys, stored via `safeStorage` when available, used directly, no proxy. This is
  the single most defensible, unqualified claim in the whole product. Lead with it.
- **Oracle's speed win, scoped honestly.** The `ttftMs` instrumentation is real, measured from actual
  fetch timing (`main.ts:1110-1116`, `1193-1205`), not invented, and `docs/ORACLE.md` is explicit about
  its actual boundaries: pinned local chat only, off by default, side-effect-free when off. Promote the
  measured number for exactly the scenario it covers ("pin a local model, Oracle makes it feel
  instant"), not as a blanket "Metis is fast" claim.
- **The orchestration graph and default build pipeline.** Real, working, independent of the broken
  policy bridge. `defaultAgenticStages` (`main.ts:5488-5504`) is a sensible hardcoded fallback chain
  (Gemini/Claude/DeepSeek, each falling through to local) that produces actual files. "Point it at a
  folder, describe what you want, it writes real code" is a claim you can stand behind today.
- **Pin, don't auto-route, for now.** Given Risk 1, the honest v1 story is "pick your model, Metis
  gets out of the way and calls it directly, with Oracle warming it while you type." That is a
  legitimately good, reliable, fast experience. "The router picks the best model for every task" is
  the pitch to grow into once Risk 1 is actually fixed, not the one to lead with today.

What not to promote yet: adaptive Auto Router (Risk 1), the multi-agent "team that collaborates"
framing (Risk 5, unverified), Manager as an autonomous away-worker (Risk 9), and the depth/richness of
Gallery, Marketplace, and Community, all of which are early and hidden in this plan.

---

## Summary: if you do five things before promoting this

1. Fix Risk 1 (Auto Router's fake decision) or relabel it honestly. This is the one that would
   embarrass you the most, because it's the exact claim you're proudest of.
2. Fix Risk 2 (the swallowed error message) at the same time; it's a five-line change in
   `buildAssistantText` and it's the difference between "confusing" and "clear" for every failure mode
   Risk 1 causes.
3. De-theater the onboarding hardware check (Risk 3) and add a skip path (Risk 4). Cheap, high
   first-impression value.
4. Apply the `V1_HIDDEN_NAV`/`V1_HIDDEN_SETTINGS` cut (section A). An afternoon of work, and it turns
   "sprawling and half-verified" into "small and confident."
5. Run `docs/LIVE_TESTS.md` once, end to end, for whatever you decide stays visible in v1. You already
   wrote the checklist. Nobody has run it.
