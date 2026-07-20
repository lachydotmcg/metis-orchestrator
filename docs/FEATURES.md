# Features, in detail

Per-feature documentation for Metis Orchestrator: what each part does, what it does not do, and which files it lives in.
The README is the short version. This is the long one, and it is where the honest limits live.
Every section carries one of five markers in its summary line, so you can tell what is real without opening anything.
Known gaps and rough edges across the whole app live in [`LIMITATIONS.md`](LIMITATIONS.md).

| Marker | Means |
| --- | --- |
| `VERIFIED` | Ships in v1, and there is a recorded run behind it, not just a green build. |
| `SHIPPED` | Ships in v1 and is reachable from the nav. Works when driven by hand, but no recorded run behind it. |
| `FLAG OFF` | Built and wired up, but the flag defaults to `false`. Nothing happens until you turn it on. |
| `HIDDEN` | Built, code fully intact, not reachable from v1's navigation. Un-hiding it is deleting a string from one `Set`. |
| `PLANNED` | Designed, not built. No code exists. |

---

# Ships in v1

<details>
<summary><b>Chat and the Auto Router</b> · <code>SHIPPED</code> · Type a prompt, Metis picks a model that is actually installed.</summary>

<br />

`src/electron/builtinRouter.ts`. This exists because the original router shelled out to a separate `metis-policy` CLI resolved from sibling paths, which `electron-builder` never bundled. On every machine that was not the developer's, it silently fell back to one hardcoded answer for every prompt ever typed. The headline feature worked for exactly one person on Earth.

The built-in router runs in-process and makes a real decision:

1. **Classify.** Keyword rules, ordered by specificity, into one of six task types: `private_sensitive`, `frontend_design`, `coding`, `summarisation`, `long_context`, `general_chat`. A prompt over roughly 3000 estimated tokens falls to `long_context` only when no keyword signal matched first. Anything else unmatched is `general_chat`.
2. **Check what exists.** Ollama tags actually pulled on this machine, and cloud providers that actually have a key saved.
3. **Order by your preference.** Local-first, cloud-first, or hybrid (captured during onboarding). In hybrid, the tasks where a frontier model measurably wins (coding, frontend design, long context) prefer cloud when one is configured, and everything conversational stays local and free.
4. **Never send sensitive prompts out.** `private_sensitive` gets a null cloud option and always stays on the machine, whatever your preference says.

Every decision carries evidence: what it classified the prompt as and on which matched word, how many local models are installed, which cloud providers are configured. Routes it produces are tagged `builtin-0.1.0` as both `policy_version` and `ruleset_version`. If nothing is available at all it still returns a well-formed decision that says so, so you get "install a local model with Ollama, or add a provider key in Settings" rather than a dead end.

If you happen to have the `metis-policy` CLI and a profile present, that still wins. The built-in router is what runs everywhere else, which is to say on every installed copy.

You can also skip routing entirely and pin a model in the composer.

**Honest limits:**

- The classification is keyword matching plus a length rule, not a learned model. Confidence values are fixed constants (0.72 on a keyword hit, 0.6 for a long prompt, 0.55 for the general fallback), so treat them as a category label rather than a calibrated probability.
- It never names a local model you have not pulled. For cloud it checks that you have a key for the provider, not that your account can actually reach that specific model.
- Real decisions are tagged `builtin-router-0.1.0`. The `sample` source you may see in a browser preview is a demo decision for the settings panel, not something a real run produces.
- There is no recorded run of this in a packaged build yet, which is why the marker is `SHIPPED` and not `VERIFIED`. Given what the original bug was, that distinction matters here more than anywhere else in this document.
</details>

<details>
<summary><b>The orchestration build pipeline</b> · <code>VERIFIED</code> · Plan, then front end, then make it functional, writing real files.</summary>

<br />

Ask for something buildable and the run goes through staged model calls instead of one. The default pipeline is three stages, each with its own fallback chain that ends in your local model so the flow always completes:

| Stage | Default chain |
| --- | --- |
| Plan | Gemini, then Anthropic, then local |
| Front end | Anthropic, then DeepSeek, then local |
| Make functional | DeepSeek, then Anthropic, then local |

If you have pinned a model, it goes first in every chain and these become its fallbacks.

Things that are true about this path:

- **It checks the folder before deciding.** Every build against a writable workspace reads what is already there first and reports it ("12 files, index.html present" or "empty folder"), so create-versus-edit is a decision made from the folder, not guessed from your wording.
- **Every model call is visible.** Each stage emits its own `stage_call` events with the prompt preview, the provider and model that handled it, and the output, so you can see what each stage actually said.
- **It verifies and repairs.** Builds run a verification pass and can self-repair, up to a limit of 2 repair passes, using the real failure evidence: verification detail, console errors, failed commands with their exit codes and stderr.
- **Failures are named.** If a stage falls through its whole chain, the fallback notes say so per stage rather than the run quietly reporting success.
- **Every write is snapshotted first.** See "The snapshot safety net" below. That is not a separate mode, it is the only write path.

You can also author the pipeline visually in the **Orchestration** view: router, agent, and skill nodes, each with its own model, gateway, and ordered gateway fallbacks. Gateway config lives on the model itself, so you set it once in the Library and it follows the model to every node it appears on.

**Honest limit:** if you ask for a single-file front end, the functional stage is dropped on purpose. And in `plan` permission mode the pipeline stops after the plan stage and tells you plainly that nothing was written.
</details>

<details>
<summary><b>The CLI harness</b> · <code>VERIFIED</code> · Drive the real pipeline headlessly, and assert on the result.</summary>

<br />

`src/electron/cli.ts`. It lets an engineer or CI exercise the real pipeline headlessly instead of guessing from a browser preview, and it found three ship blockers within an hour of existing.

```bash
npm run cli -- doctor [--json]
npm run cli -- chat "<prompt>" [--project <path>] [--model <provider/model>] [--json] [--timeout <s>]
npm run cli -- build "<prompt>" --project <path> [--model <provider/model>] [--json] [--timeout <s>]
npm run cli -- loop "<goal>" [--max-iterations <n>] [--project <path>] [--respect-delays] [--json]
```

(`npm run cli` is `electron . --cli` under the hood, so the `--` matters.)

`doctor` is read-only and runs nothing: is Ollama reachable and what is pulled, which provider keys are configured and how they are stored (names only, never values), whether the policy CLI is available, the active project workspace, the self-verify policy, every feature flag with its current value and its documented default, and where app data lives.

`loop` deliberately rejects `--model`, with the reason printed: every loop iteration routes through the Auto Router. Its timeout budget (1800 seconds by default, against 300 for chat and build) is spent across every iteration together rather than per iteration.

The design property that makes this worth trusting: **the CLI never reimplements pipeline behaviour.** Every piece of real app behaviour is injected from `main.ts` as a plain object built from the same functions the IPC handlers call. "The CLI passed" and "the app works" mean the same thing.

Exit codes are meaningful, so CI can assert on them: `0` success, `1` threw, `2` bad flags (nothing ran), `3` ran but got no real answer (Ollama unreachable with no cloud key, every stage failed, verification failed, a loop iteration errored), `124` timed out.

**Honest limits, both stated in the tool's own help text:** every CLI run uses permission mode `auto` and there is no way to change it, because there is no human present to answer a prompt. In-run permission requests are auto-approved for that run only (never "always", so nothing new is persisted beyond the workspace grant `--project` creates), and `<ask_user>` questions are answered with their first offered option. Every one of those auto-decisions is printed as it happens.
</details>

<details>
<summary><b>Metis Loops, phase 1</b> · <code>VERIFIED</code> · A goal Metis works across several turns, deciding each turn whether to continue.</summary>

<br />

`src/electron/loops.ts`. A loop is a goal Metis wakes itself up to keep working on. Each iteration ends by emitting a fenced decision block:

````
```metis-loop
{ "decision": "continue", "delaySeconds": 900, "reason": "why you need another turn" }
```
````

**The governing rule is that continuing is an explicit act, and silence stops the loop.** A model that forgets to answer, replies in prose, emits malformed JSON, returns an array, gives a bogus decision value, or crashes mid-sentence all land in the same place, which is the loop ending. The failure mode being designed out is a loop that runs all night because nobody said stop, which is the one bug in this feature that costs real money while you are asleep. The decision parser is adversarially tested at 41 out of 41 on exactly those cases, and every ambiguity resolves toward stopping.

The parser takes the **last** `metis-loop` block in a reply, not the first, so a model that shows an example block mid-reply while reasoning out loud is not misread as having already decided.

Limits the model cannot argue past:

- **25 iterations**, absolute ceiling, whatever a caller asks for. The CLI's own `--max-iterations` default is 8, which is the number you actually get unless you pass one.
- **12 hours** wall clock from creation.
- **Delay clamped to 60 to 3600 seconds.** A confused model answering `delaySeconds: 0` cannot spin a hot loop of real inference calls, and a loop cannot park itself past the horizon where you have forgotten it exists.
- **Permission mode is frozen at creation** and never re-read from settings, so a loop cannot gain permissions it did not start with.

Start one by typing a command in any new session:

```
/loop <goal>                     it decides its own pace
/loop --turns 5 <goal>           cap the iterations
/loop --every 15m <goal>         fixed gap instead of self-paced
```

Typing any of it renders a live breakdown under the composer naming what each part will do, with the parts you typed shown bright and the applied defaults shown muted, so the grammar teaches itself. A malformed flag shows the reason and refuses to send rather than guessing. The parser is shared between the hint and the thing that runs, so the strip cannot promise something that will not happen, and it is tested at 53 out of 53 including every malformed case.

`--every` is a fixed-interval override that replaces the gap the model asked for with your own schedule. It overrides the gap only. The model is still asked each turn whether to continue, and silence still stops the loop, because a fixed interval must never become a way to make a loop run forever. It allows up to 6 hours where the model itself is clamped to 1, because that clamp exists to stop a confused model parking a loop past the horizon, and a person typing `--every 2h` is describing a schedule they want.

Each wake replays a short digest of what previous turns already did, so iteration 4 does not redo iteration 2. The goal is always placed first and alone in the wake prompt, because routing classifies chat-versus-build from the prompt text: an earlier version buried the goal under scaffolding, and a read-only question ("how many functions does app.js define?") routed as a build and rewrote the file down from 171 lines to 10. That is fixed, and it is in the code comments so nobody undoes it.

Live proof run, on a real file: "add a one-line JSDoc comment above each function in app.js, two per turn, keep going until every function has one." Four turns, against the 14-function sandbox:

```
iteration 1: continue - four functions still need comments
iteration 2: continue - four functions still need comments
iteration 3: continue - two functions remain without comments
iteration 4: stop     - every function now has a comment
```

14 of 14 documented, file still valid JS, and it stopped itself when the job was actually done rather than running to its cap.

A turn that does real work routes to the build pipeline, whose reply is a summary of what it did rather than a model answer, so there is nowhere for a decision block to come from. Before that was handled, every loop that did real work ran exactly one turn and stopped, which looked like working and was not. The decision is now asked as a separate small call when the work turn cannot carry one, and a failed or unreadable answer still ends the loop.

The Loops panel (Settings > Privacy & Data) lists every loop with its status, iteration count, next wake time, and the model's own stated reason for the gap it chose, expands to show what each turn actually did, and can stop any live one in a single click. It lives there rather than under Routines specifically because Routines is hidden in v1, and a loop must never be running with no surface to see or stop it. The tray's "Pause background work" also halts every sleeping loop.

**Honest limits.** Phase 1 is one loop working alone: there is no spawning of parallel workers and no waking on a worker finishing, both of which are phase 2. There is no token budget yet, so the iteration and wall-clock caps are the only spend ceilings. And nothing checks that the model driving a loop is capable enough to reliably decide to *stop*, which the design doc asks for and which matters most on small local models. The caps bound the damage; they do not make a 4B model good at knowing when it is done.

A related safeguard: a loop records which surface created it. CLI loops are never resumed by the desktop app on a later launch, so pressing Ctrl-C partway through leaves a stopped record rather than an autonomous run that fires inside the app hours later that you never created and would not think to look for.
</details>

<details>
<summary><b>Providers, gateways, and fallback chains</b> · <code>SHIPPED</code> · Your keys, your models, and a route that survives one going down.</summary>

<br />

Every model in the orchestration Library can be given a **gateway** (which provider to reach it through) plus an ordered list of **gateway fallbacks**. Set it once on the model and that config follows it to every node it appears on.

At call time, the explicit preference list is tried first in exactly the order you gave, skipping routes that are not configured, before falling through to the model's remaining access routes by healthy-first ordering. Routes that recently failed go on cooldown and are skipped. Every fallback that fires is recorded in the stage's fallback notes, so a run that quietly degraded still tells you it degraded.

NVIDIA NIM and Groq are both OpenAI-chat-schema-compatible, so they slot into the same call path with a different base URL. OpenRouter works the same way, which means an OpenRouter subscription you already pay for can carry the models you already have access to.

**Honest limit:** the older Settings-level "default gateways" map is deprecated. Nothing in the renderer writes to it anymore. It survives only as a last-resort lookup for a value you may still have on disk from before the rework.
</details>

<details>
<summary><b>Knowledge banks</b> · <code>SHIPPED</code> · Local embeddings over your project files, grounding the prompt in what is really there.</summary>

<br />

On by default (`knowledgeBankEnabled`, the one flag whose default is `true`). When a run has a project folder, Metis builds or reuses a cached local embeddings index over that project's files and retrieves the most relevant chunks to prepend as context.

Concrete parameters, all in `main.ts`: embeddings via Ollama's `/api/embeddings` using `nomic-embed-text`, chunks of 1500 characters, up to 200 chunks indexed, top 4 retrieved, similarity floor 0.3, context block capped at 6000 characters. The index is cached to app data and keyed by a signature over file sizes and modification times, so it rebuilds only when the project actually changed.

When retrieval succeeds you get a **"Grounded on N chunks"** row in the run, and it carries per-chunk provenance: file, chunk ordinal, and a snippet of each chunk. That is deliberate. You can spot a wrong or stale chunk steering an answer instead of wondering where a claim came from.

**Honest limits:** this needs Ollama running with `nomic-embed-text` pulled. Without it the flag is on and nothing is retrieved. Every function in the path fails soft, returning null or an empty array on any error, so if embeddings are unavailable the run is byte-identical to one with no knowledge bank at all. It changes nothing and says nothing, which is correct behaviour but does mean a silent no-op is indistinguishable from "nothing relevant was found" unless you check that the model is pulled.
</details>

<details>
<summary><b>Onboarding and the Benchmark</b> · <code>SHIPPED</code> · Hardware-matched local model picks before you are dropped into the app.</summary>

<br />

First launch walks you through your name, a Local / Cloud / Hybrid preference (this feeds the Auto Router's ordering directly), a hardware check with model recommendations, and one-click installs for the picks. You land on a real local profile, bring-your-own-keys by default.

**Be clear about what the Benchmark is.** Its own button reads "Run benchmark (simulated)", and the decode and VRAM figures are simulated captures, not measured inference. It is a sizing guide with a progress bar, not a benchmark.

**Also worth knowing:** navigation is gated until the Benchmark wizard completes. Until then only Benchmark and Settings are reachable. That is intentional, since an app with no model and no key cannot answer anything, but it does mean the first run has a required step rather than an optional one.
</details>

---

# Trust: the parts that decide whether you point this at a real repo

<details>
<summary><b>Permissions: the five modes</b> · <code>SHIPPED</code> · You pick how much Metis may do on its own, per run.</summary>

<br />

Every file write, command, and new network scope in a run passes through `gatePermission` (`src/electron/main.ts`), and it answers according to the mode you picked in the composer's permission pill.

| Mode | Pill label | Behaviour |
| --- | --- | --- |
| `ask` | Manual | Every file write, command, and new network scope pauses the run and asks. |
| `edits` | Accept edits | File writes proceed. Commands and new scopes still ask. |
| `plan` | Plan | Read-only. The build pipeline runs the plan stage and stops before it can write anything. |
| `auto` | Auto | Default. Proceeds, and asks once when there is no existing grant covering that scope and folder. |
| `bypass` | Bypass | No prompts at all. Styled red in the UI for a reason. |

Two properties worth knowing:

- **Writes are authorised by the folder, not by a label.** A `filesystem.write` grant is matched against the resolved project path, so a grant for one folder can never widen to another one. Attaching a folder (either through "Choose folder" or "+ Add folder") is what creates that grant, and only one workspace is writable at a time. Attaching a new folder replaces the previous one.
- **A prompt is a real pause.** In-run prompts stream to the renderer as a `permission_request` event and the run genuinely waits. Allow-once, always-allow, or deny. "Always" writes a persisted grant, nothing else does.

Your mode selection persists across runs (store key `permissionMode`, default `auto`). A Loop freezes its mode at creation and never re-reads the global, so changing the setting later cannot escalate a loop that is already running.

**Honest limits:**

- `plan` mode short-circuits the build pipeline after the plan stage, and `gatePermission` returns "do not proceed" defensively for anything that still reaches it. It is a strong read-only guarantee for the build path specifically, not a kernel-level sandbox.
- `gatePermission` is the gate for the run pipeline, and it is not the only code that touches disk. The Graph View document viewer's read and write IPCs are guarded separately by `assertMetisFilePathAllowed`, using grant-shape checks rather than a `gatePermission` call. Path containment is consolidated. A single permission gate for the whole app is not a claim this documentation will make.
</details>

<details>
<summary><b>The snapshot safety net</b> · <code>VERIFIED</code> · Every generated write is backed up first, or it does not happen.</summary>

<br />

`src/electron/projectSnapshot.ts`. Permissions decide *whether* a write happens. This decides whether it is *recoverable*, because "trust the model" is not a recovery strategy.

Every generated write in the app funnels through one function (`writeGeneratedFileSet`), so there is exactly one place the net belongs. Before a single byte is written:

1. **Always:** the current contents of every file about to be touched are copied into a snapshot folder in app data, with a `snapshot.json` manifest recording which paths did not exist before (so a revert knows what was new). Bounded to just the files in the write set, so it is fast, and it works in a folder with no version control at all.
2. **When the folder is a git repo:** additionally, a `git stash create` commit is recorded under `refs/metis/snapshot-<id>`, unless the tree is already clean, in which case HEAD is already the restore point and no ref is written. When it does run it captures the whole working tree, not just the touched files. `stash create` was chosen specifically because it writes a commit object without touching the index, the working tree, or your stash list, so it cannot disturb work in progress. Metis never runs `git init`, never commits to a branch, and never rewrites history.

**Failure is closed.** If layer 1 throws, the write is abandoned and you get an error naming the folder: "Metis could not back up `<root>` before writing, so it did not write anything. Check the folder is readable and try again." That is the correct trade when the whole promise is recoverability. Layer 2 failing is ignored on purpose, because layer 1 already covers recovery.

Undo lives in **Settings > Privacy & Data > Undo the last AI write**. It shows how many files were backed up, which project, when, and the git ref if there is one.

**Honest limits, both deliberate:**

- **A revert restores files that already existed. It does not delete files the run created.** Restoring content is safe and reversible, and deleting a file you may have edited by hand since is not. The panel says plainly that the new files will not be deleted, and leaves them for you to decide.
- **Only the most recent write is revertable from the UI.** The store keeps one `lastProjectSnapshot`. Older snapshot folders still exist on disk with their manifests, but there is no history browser yet.
</details>

<details>
<summary><b>Local-first, and bring your own keys</b> · <code>SHIPPED</code> · No account, no telemetry, no Metis server in the path.</summary>

<br />

There is no sign-up, no Metis backend, and no analytics. Conversations, routing decisions, the audit log, and your keys all live in the app's own data directory on your machine.

Data leaves your device in exactly two situations, both yours to control:

1. **You routed a task to a cloud provider you configured.** The prompt goes to that provider, on your key, under their privacy policy. Keep everything on Ollama and nothing leaves the machine.
2. **The app fetches the public registry** (model catalog, marketplace packages, community feed) from a public GitHub repo. Ordinary read-only downloads, no personal data attached.

Seven cloud provider keys, plus Ollama, which needs no key: Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, NVIDIA NIM, and Groq. Keys are entered in **Settings > Providers**, or picked up from the usual environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and so on) if you prefer that.

**Honest limit on key storage:** keys go through Electron's `safeStorage` and are encrypted with the OS keychain **when `safeStorage.isEncryptionAvailable()` returns true**. When it does not, which happens on some Linux setups without a keyring, Metis falls back to base64 on disk, and that is encoding, not encryption. The app records which of the two was used and shows it back to you as the key's storage source. It does not pretend.

There is also an audit log (`Settings > Audit`) that records permission grants, snapshots, workspace selections, routing fallbacks, and errors. Values of secrets are never written to it, only which fields changed.
</details>

---

# Built, shipped, and off by default

Everything in this group works, and nothing in it happens until you turn it on. Flags default to `false` and their off-state is byte-identical to the code path that existed before the feature was built. Describing any of it as something Metis "does" would be a lie, which is why it is in its own group.

<details>
<summary><b>Oracle: speculative drafting</b> · <code>FLAG OFF</code> · Prewarms and drafts your answer while you are still typing.</summary>

<br />

Three separate opt-ins, all in **Settings > Chat > Experiments**, all default off:

- **`prewarmEnabled`, "Prewarm local models as you type".** While you type, the renderer fires a quiet warmup so the local Ollama model's prefill and KV cache are primed before you hit send. It also caches the routing decision for that exact prompt hash, so an unchanged prompt at send skips the routing step entirely and the timeline says "Route decided ahead of time." When the drafted answer matches your sent prompt by exact hash, it is served immediately.
- **`oracleCloudEnabled`, "Cloud Oracle via DeepSeek".** The paid sibling. When a DeepSeek model is pinned, Oracle drafts through your own DeepSeek key while you pause typing. The UI states plainly that this sends your in-progress prompt to DeepSeek and costs tokens on every draft. Requires the prewarm flag on *and* a saved DeepSeek key, both enforced in the main process, not just in the UI.
- **`oracleSimilarityEnabled`, "Oracle near-match serving".** Serves an already-drafted answer when your final edit before sending was only cosmetic. Guarded by a lexical veto (negations, numbers) plus a local embedding check on just the divergent part of the prompt. A served near-match is always labelled with its honest match percentage and is never presented as identical to a fresh answer. Needs `nomic-embed-text` pulled.

Where it runs, and what it leaves behind:

- **With only `prewarmEnabled` on, every fetch is local**, straight to `http://127.0.0.1:11434`. Turning on `oracleCloudEnabled` adds a DeepSeek draft path, and that is real spend on your key, on every draft, whether or not the draft is ever used.
- **Nothing is persisted.** No conversation record, no run record, no file write. A discarded draft leaves nothing on disk.

Two structural safeguards: an Oracle draft is never served for a turn where tools are enabled, because the tool instruction block is appended before the hash check, so a draft made without tools cannot be served for a prompt that has them. And an image attachment always disqualifies a served draft.

**Honest limit:** this documentation makes no speed claim. Prewarming is a real mechanism with a real design (see [`ORACLE.md`](ORACLE.md)), and how much it saves depends entirely on your model, your hardware, and how long you pause. Turn it on and measure it on your own machine.
</details>

<details>
<summary><b>Agentic tools: read, list, targeted edit</b> · <code>FLAG OFF</code> · Lets a model look at your files instead of guessing at them.</summary>

<br />

`src/electron/agentTools.ts`, store key `agentToolsEnabled`, default off, and it additionally requires a writable project workspace, since there is nothing to read or edit otherwise.

The problem it fixes is specific. Without tools a model is handed a blob of file contents and must reply with whole replacement files, blind. A CLI sweep caught the cost directly: asked to extract a repeated constant, the model never read the file and invented a plausible but wrong key name.

Phase 1 is exactly three tools, and no more:

- `read_file`, capped at 60,000 bytes (truncated with an honest note past that) and restricted to an allowlist of roughly 37 text extensions (`.ts`, `.tsx`, `.js`, `.py`, `.md`, `.json`, `.css`, `.html`, `.yml`, and so on). Anything outside that list is refused, so a project with unusual extensions will hit a refusal.
- `list_files`, max depth 3, 200 entries, skipping `node_modules`, `.git`, `dist`, `build`, and friends.
- `edit_file`, a targeted find-and-replace, not a whole-file rewrite.

`run_command` is deliberately **not** here. It is the only tool whose blast radius is the host OS rather than a folder, so it ships last, narrowest, and separately.

Two safety properties the module owns outright:

- **Containment.** Every path argument resolves inside the project root, using a trailing-separator check (so a sibling folder like `project-secrets` cannot pass as inside `project`) plus a realpath pass so a symlink cannot point out. Rejection is an explicit error handed back to the model, never a silent skip.
- **Credential-shaped filenames are refused outright.** The list: `.env*`, names where `secret` or `credential` starts the name or follows a dot, underscore, or hyphen, plus `.pem`, `.key`, `id_rsa`, and `.pfx`. Be precise about what that is, because "the model asked nicely" is not an access-control policy and neither is an overstated denylist. It is a **name** check on the filename, not a content scanner. `mysecrets.txt` does not match the pattern and is readable. Dotfiles are skipped when *listing* a directory, but a dotfile that is not credential-shaped can still be read by name.

`edit_file` requires its `find` text to appear exactly once. Zero matches means the model is guessing, several means the change is ambiguous, and both are refused with a reason it can act on. A deliberate rename passes `"all": true` to change every occurrence, which is the model saying "yes, every one" explicitly.

Tool edits never touch disk directly. They hand a pending write back to the caller, which puts it through the normal write path, which means the snapshot safety net covers everything a tool changes.

**Honest limit:** in v1 there is no supported way to turn this on. No Settings toggle, no CLI flag, and it does not appear in `doctor`'s flag list. It is wired and waiting for a release that exposes it.
</details>

<details>
<summary><b>Metis Gateway: a local OpenAI-compatible endpoint</b> · <code>FLAG OFF</code> · Point any OpenAI-compatible tool at Metis and get routed calls.</summary>

<br />

Toggle in **Settings > General**, store key `gatewayEnabled`, default off. Turning it on starts the server immediately, no restart needed.

Point any OpenAI-compatible app, script, or tool at `http://127.0.0.1:11500/v1` with your Metis bearer token, shown masked by default in the same panel. 11500 is the default, and the port is configurable through the `gatewayPort` store key. Leave the model as `metis-auto` and the request gets the same Auto Router decision a composer turn gets, then a plain text-in, text-out call. No orchestration stages, no project tools, no knowledge bank. Or pin a specific model.

Bound **strictly to 127.0.0.1**, so nothing outside your machine can reach it, and token-gated, so other local software cannot call it without the token. Request bodies are capped at 4MB. Bind failures, a port already in use for instance, are caught, audited, and reported rather than thrown, so a busy port cannot take the app down with it.
</details>

<details>
<summary><b>Multi-agent fan-out</b> · <code>FLAG OFF</code> · A build splits across named sub-agents, each claiming its own files.</summary>

<br />

Store key `fanoutEnabled`, default off. A build request is decomposed by one cheap local planning call into 2 to 4 sub-tasks, each owning a distinct file territory, coordinated by an in-memory claim ledger so two agents can never write the same path. Agents are named (Nyx, Talos, Echo, Atlas, Juno) and each stage call is tagged with its agent, so the UI can present them as separate side-chats. A `METIS-SPEC.md` living-spec document is written into the workspace root and updated as each agent works, so the plan is something you can open rather than scrollback you have to scroll.

**Honest limits:** v1 runs the sub-agents **sequentially** under the hood, one staged call each, while tagging them distinctly. The parallelism is in the decomposition and the territory model, not yet in the execution. Fan-out never engages for a single-file request. Any failure anywhere in the path falls back to the untouched single pipeline, so a fan-out attempt can never make a build worse. Like agentic tools, there is no Settings toggle: it is a store key only.
</details>

<details>
<summary><b>Depths: routing by how hard the turn is</b> · <code>FLAG OFF</code> · Trivial work stays cheap, only the deep questions reach your strongest model.</summary>

<br />

Routing by task answers "what kind of work is this". Depths answers the other question: "how hard is this particular piece of it". With it on, a node stops being one model and becomes three rungs, and the router judges each turn's weight and sends it to the matching one.

| Rung | Meant for | Default when you leave it unset |
| --- | --- | --- |
| **L1** | Trivial turns. A quick lookup, a one-line answer. | Your local model, so it costs nothing. |
| **L2** | Ordinary work. | Whatever the router would have picked anyway. |
| **L3** | The genuinely hard turns. | **The node's own model**, so whatever you dragged on stays the honest fallback for deep questions. |

Any rung can also be set to **the router answers it**, meaning no re-route at all: the router model handles that level itself.

This is where "cheapest" comes from. A pipeline where every turn hits your strongest model pays frontier prices for work a 4B local model would have finished correctly. Depths is the difference between paying for capability and paying for capability *you needed*.

**The node shows this, rather than hiding it.** A depths-enabled node displays all three rungs with their providers instead of a single model name, because a node captioned "Fable 5" while L3 is pinned to Opus 4.8 tells you the opposite of the truth about your hardest tasks. Rungs you pinned read bright, inherited ones read quieter but stay legible, since an unset level is not an empty slot.

**Honest limits:**

- It is off by default (`depthRoutingEnabled`), and the toggle lives on the node's own Depths panel.
- The node's stack mirrors into a single global `depthRoutes` store that the shipped engine reads, so with several depths-enabled nodes the last one projected wins. True per-node consumption inside the pipeline is the noted follow-up.
- A stack configured while the flag is off is shown greyed out and labelled as inert, rather than pretending it is live.
</details>

<details>
<summary><b>Model-driven routing</b> · <code>FLAG OFF</code> · Let a model do the classifying instead of keyword rules.</summary>

<br />

**`modelDrivenRoutingEnabled`** (toggle in Settings > Chat > Experiments): a fast local model classifies each prompt as chat or build instead of the keyword rules. Falls back to the rules on any failure, so turning it on cannot make routing worse than the rules it replaces.
</details>

<details>
<summary><b>MCP, both directions</b> · <code>FLAG OFF</code> · Metis can call MCP tools, and be an MCP server.</summary>

<br />

**Outbound** (`mcpToolsEnabled`, default off): chat runs can call the tools of MCP servers you have installed. The v1 mechanism is prompt-based tool calling, since the provider paths here are plain prompt-to-text calls with no native tool-call support. Tool schemas are appended to the prompt, the model requests a call with a single JSON directive, and Metis executes it against the installed server's stdio process and feeds the result back.

**Inbound:** `scripts/metis-mcp.mjs` is a zero-dependency stdio JSON-RPC bridge that lets any MCP client (Claude Code, Cursor, anything speaking MCP over stdio) reach your running Metis Gateway. It exposes `metis_route` (Auto Router), `metis_ask_model` (a specific model), and `metis_models`. So an outside agent can lean on Metis's routing rather than picking a model itself. Setup is in [`MCP_SERVER.md`](MCP_SERVER.md).

**Honest limit:** the **Settings > MCP servers** panel is hidden in v1, because it spawns arbitrary local stdio processes for installed servers and that is a trust surface worth holding back. The inbound bridge script is unaffected, since it runs outside the app.
</details>

<details>
<summary><b>Quick-ask hotkey and headless start</b> · <code>FLAG OFF</code> · Ask Metis anything from anywhere, or run it with no window.</summary>

<br />

- **`quickAskEnabled`**: Ctrl+Alt+M summons a small always-on-top prompt bar anywhere in Windows, routed exactly like a normal chat turn, with an open-in-app link on the answer. Toggle in Settings > General. **Needs a restart to take effect.**
- **`headlessStart`**: start Metis hidden in the tray with no window, either from the toggle or the `--headless` flag, while the Gateway keeps serving in the background. "Open Metis" in the tray brings the window back.
</details>

---

# Built, but hidden from v1

The code is fully intact for all of these. Every component, IPC handler, and store key stays exactly as it is. Bringing one back is deleting a string from `V1_HIDDEN_NAV` or `V1_HIDDEN_SETTINGS` in `src/renderer/ui/App.tsx`. They are hidden because v1 is chat plus orchestration, and everything peripheral, early, or trust-heavy waits its turn.

One entry at the end of this group is different, and is marked `PLANNED` so it cannot be mistaken for hidden code: it is designed and written up, and no code exists for it yet.

<details>
<summary><b>Manager, To Do, and the agent board</b> · <code>HIDDEN</code> · A manager agent and a kanban board it works from.</summary>

<br />

Hidden because the code's own comment is more honest than the pitch was. The v1 Manager's suggestion actions are all local: they mutate the shared todo board store and navigate within the app, and never make a model or API call. The deeper ones (auto-triage, drafting replies, running commands) have to route through the existing permission ceremony first, and they do not yet. So today it is a todo board with a chat window attached, not the autonomous worker it was described as, and shipping it under the old description would be the exact kind of overpromise this release is trying to stop.

To Do is hidden alongside it: a generic kanban that mostly exists to support Manager.
</details>

<details>
<summary><b>Marketplace and registry</b> · <code>HIDDEN</code> · Browse, install, and publish skills, MCP connections, and presets.</summary>

<br />

SHA-256 verification against the manifest digest before install, and publishing via a reviewed pull request against a separate registry repo. Note the shape of that check: a package whose manifest declares no `sha256` field installs with no verification at all, because a missing digest is not a mismatch. Hidden regardless, since installing arbitrary skills and MCP servers is a large trust surface for a feature that is not core, and the registry it depends on is early.
</details>

<details>
<summary><b>Routines</b> · <code>HIDDEN</code> · Scheduled runs on a timer.</summary>

<br />

Nothing here is broken, it is just not core. Scheduled automation is a later feature by design. Note the consequence: because Routines is hidden, the Loops panel moved to **Settings > Privacy & Data**, so an autonomous run always has a surface that can see and stop it.
</details>

<details>
<summary><b>Gallery and Graph View</b> · <code>HIDDEN</code> · Reference images that describe themselves, and a force-directed memory graph.</summary>

<br />

Gallery was already held back once for needing more work, and it requires pulling a vision model, which is onboarding friction for a non-core view. Graph View is genuinely peripheral: its main value, knowledge provenance, already shows inline in chat as the "Grounded on N chunks" row.
</details>

<details>
<summary><b>Community feed</b> · <code>HIDDEN</code> · Releases, new packages, what others are publishing.</summary>

<br />

Depends on a remote feed that is still mostly empty. An honest empty state is still an empty room.
</details>

<details>
<summary><b>Settings > MCP servers, and Settings > Usage</b> · <code>HIDDEN</code> · Two settings sections held back.</summary>

<br />

**MCP servers** spawns arbitrary local stdio processes for installed servers. Real trust surface, and the `mcpToolsEnabled` flag underneath it already defaults off.

**Usage** is well built and honestly labelled: per-provider, per-model, and per-actual-route token counts and cost estimates, computed locally from your own runs, with a 4-hour rolling ring by the composer. It is hidden because it is a read-only report over data already being collected, so it costs nothing sitting hidden until its ring has a live-test tick against it. Its limits were always display-only anyway. Nothing throttles you yet, and the UI said so.
</details>

<details>
<summary><b>Flowchart Loops</b> · <code>PLANNED</code> · A loop given an ordered chain of steps, written as text.<br />Designed only. No code exists, nothing in the app does this today.</summary>

<br />

Design notes live in [`FLOWCHART_LOOPS_DESIGN.md`](FLOWCHART_LOOPS_DESIGN.md). Read that as a proposal, not a description of behaviour: nothing in v1 implements it, there is no flag to turn on, and `doctor` will not list one.
</details>
