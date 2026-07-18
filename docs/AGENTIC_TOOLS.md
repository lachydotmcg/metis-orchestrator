# The Agentic Tool Loop - Design

Status: DESIGN ONLY. Nothing in this document is implemented. Written from a
read-only pass over the current repo so every claim in section 1 traces to a
real function and line number, the same discipline `docs/SECURITY.md` holds
itself to. If the code has moved by the time you read this, trust the code
and fix the citation.

Written because the owner's ask was specific: "give the agentic cloud agents
the abilities to actually test things or perform agentic tasks." Today Metis
generates whole files from a prompt and checks them afterward. It cannot read
a file, run a command, or look at its own output mid-turn. This document
designs the loop that fixes that, reusing the one mechanism in the codebase
that already does something close to it (P10.2's MCP tool loop) instead of
inventing a second parallel system, and treats safety as the primary design
constraint, not an add-on, because the owner said plainly he is scared to
ship this.

---

## 1. What actually exists today

### 1.1 The build pipeline: generate blind, write, verify, repair

`runOrchestratedStages()` (`src/electron/main.ts:7512`) runs an ordered list
of stages, normally plan -> frontend -> functional (`resolveAgenticStages`,
falling back to `defaultAgenticStages` when no graph pipeline is configured).
For each stage it:

1. Builds a stage prompt by string concatenation: role instructions, the
   METIS.md block, a gallery style reference, mid-run steering directives
   picked up via `takePendingDirectives`, a design-seed line, and an
   `<ask_user>` tag instruction, all appended in sequence (main.ts:7566-7648).
2. Calls `callStageWithFallback()` (main.ts:6544), which expands the stage's
   model chain into every access route of every model (`expandChainByRoutes`)
   and tries them in order, skipping providers that are cooling from a recent
   429 ("Never Run Dry"). This is real provider-fallback infrastructure, but
   it calls each model exactly **once** per stage attempt; there is no
   concept of "call again with new information" inside it.
3. If the reply contains an `<ask_user>` tag, pauses for an answer
   (`promptUserQuestion`) and re-runs the stage **once** with the answer
   folded in (main.ts:7661-7680). This is the only existing "pause, gather
   more information, continue the same stage" pattern in the pipeline, and it
   is single-shot, not a loop.
4. Runs an "is this done?" critic pass (`runCriticLoop`) that judges the raw
   text output and can ask the same model to continue if it looks
   incomplete. Still judging text, never anything on disk.
5. Returns the stage's raw text output. The model never sees a compiler
   error, a test result, or the current content of a file it already wrote.

Once all stages finish, the caller (main.ts:8697-8751) does the real work:

- `extractProjectFiles(stages)` (main.ts:6400) parses `GeneratedFile[]`
  (`type GeneratedFile = { path: string; content: string }`, main.ts:3595)
  out of the models' prose by convention: a bare filename in backticks on its
  own line before a fenced code block. **Whole files only.** There is no
  diff, patch, or line-range concept anywhere in this type.
- If extraction found nothing, `runExtractionRecovery()` (main.ts:8275,
  `EXTRACTION_RECOVERY_LIMIT = 2`, main.ts:8269) re-prompts, still blind.
- `writeProjectFiles()` (main.ts:6410) writes them via
  `buildProjectToolResult()` (main.ts:4066) -> `writeGeneratedFileSet()`
  (main.ts:3992, one `writeTextArtifact` call per file, main.ts:3968) ->
  `verifyGeneratedProject()` (main.ts:4006): `node --check` on up to 6 JS
  files via `runCommandOperation()` (main.ts:4260), plus a hidden-browser
  load of `index.html` with console-error capture
  (`verifyPreviewInBrowser`, main.ts:4518).
- If verification fails, `runRepairPasses()` (main.ts:8186,
  `REPAIR_PASS_LIMIT = 2`, main.ts:7749) dumps **every current file's full
  content** plus the verification failure text into one new prompt, asks a
  repair-model chain (DeepSeek -> Claude -> local, or the pinned model first,
  `repairChainFor`, main.ts:7765) for **complete corrected files**, merges by
  path, rewrites everything via `writeProjectFiles()` again, and re-verifies.

This is the gap stated plainly: every "check" in this pipeline is a fixed,
programmatic, post-hoc pass (syntax check, browser load) that the *pipeline*
runs on the model's behalf. The model itself never calls `read_file`,
`run_command`, or "check my work" as an action. When something is wrong, the
only lever is "regenerate the entire file from scratch, blind, one more
time." That is expensive, imprecise, and is exactly what the owner is asking
to fix.

### 1.2 P10.2: the existing model-drives-tools loop (the precedent to reuse)

There is already one real "model requests a tool, Metis executes it, the
result goes back into the prompt, the model continues" loop in this codebase.
It ships today, opt-in, off by default. It is the correct shape to
generalize rather than replace.

Location: main.ts:2723-2951 (mechanism) and main.ts:8957-9098 (where it is
wired into the plain-chat pipeline, **not** the build pipeline above).

- Gate: `readStoreValue<boolean>("mcpToolsEnabled", false)` (main.ts:8963).
  Off by default; off leaves the turn byte-identical to before the feature
  existed. This is the pattern to copy for the new flag.
- `connectMcpToolsetsForRun()` (main.ts:2849) spawns every installed MCP
  package's stdio server for this run only (`connectMcpToolset`,
  main.ts:2755, using the same `spawn()` + JSON-RPC handshake as
  `probeMcpServer`), collects their tool lists, and closes them all
  (`closeMcpToolsets`, main.ts:2867) when the loop ends, in a `finally`.
- `mcpToolPromptBlock()` (main.ts:2881) appends the connected tools' names,
  descriptions, and input schemas to the prompt as plain text, followed by a
  single fixed instruction: reply with **only** this JSON and nothing else
  to call a tool:
  `{"mcp_tool_call": {"server": "...", "tool": "...", "arguments": {...}}}`
- The model is called once (`invokeProvider`). Then a bounded loop
  (main.ts:9064-9094):
  - `parseMcpToolCall()` (main.ts:2897) tries to extract that JSON object
    from the raw reply, tolerating a fenced block or surrounding prose (three
    fallback parse attempts: the whole trimmed reply, a fenced code block, the
    substring between the first `{` and the last `}`). Returns `null` if
    nothing parses, meaning "no tool requested, this is the final answer."
  - If found, `callMcpToolForRun()` (main.ts:2927) calls `tools/call` on the
    matching connected server with a **hard 30 second timeout**
    (`MCP_TOOL_CALL_TIMEOUT_MS`, main.ts:2734) via `Promise.race`. It never
    throws: every failure (dead server, timeout, tool-reported error) comes
    back as `{ ok: false, text }`.
  - The result (truncated to 8000 characters) is appended as plain text onto
    the growing prompt string, with either "Continue: either answer the
    user, or request another tool call" or, once the cap is hit, "The
    tool-call limit for this turn is reached, answer the user now" (the exact
    closing instruction changes based on remaining budget).
  - The model is re-invoked with the grown prompt. Loop again, capped at
    `MCP_MAX_TOOL_CALLS_PER_RUN = 4` (main.ts:2733).
- Every call also gets one `emitTimeline(stream, timelineText(...))` line
  reporting success/failure and duration, and one `appendAudit()` call.

Three things about this precedent matter a lot for the new design:

1. **It is prompt-based tool calling, not native tool-call APIs.** The
   comment at main.ts:2726-2731 says so directly: every provider path here is
   "plain prompt -> text calls with no native tool-call support," so the tool
   schema is text in the prompt and the "tool call" is a JSON object the
   model has to type correctly. Any new tool loop inherits this constraint
   unless it is rebuilt on each provider's native function-calling API, which
   is a much bigger, provider-specific change out of scope here.
2. **It only runs on the plain-chat path**, gated separately from the build
   pipeline (`includeProjectTools`) that section 1.1 describes. The build
   pipeline, where the owner actually wants "test things," has no tool loop
   at all today.
3. **It never produces a real `AgentOperation`.** `AgentOperationKind`
   already declares `"mcp_call"` (`runtime-contracts.ts:712`) and
   `OperationIcon` in the renderer already has a case for it
   (`App.tsx:7762`, a `Plug` icon) and `OperationMeta` already knows how to
   summarize it. But nothing in main.ts ever constructs one: I grepped for
   `kind: "mcp_call"` across the whole file and the only place it appears is
   the type declaration. P10.2 calls `emitTimeline(stream, timelineText(...))`
   (a plain text line), never `emitStream(stream, { kind: "operation", ... })`.
   The renderer is fully ready for a real, expandable, filterable MCP-call
   operation row; the backend has just never populated one. This is a real,
   concrete gap worth closing as part of this design, not a hypothetical.

### 1.3 The permission system

Five modes, `PermissionMode` (`runtime-contracts.ts:99`): `ask`, `edits`,
`plan`, `auto`, `bypass`. `resolvePermissionMode()` (main.ts:1927) picks the
mode for a run. Every scoped action is meant to funnel through one function,
`gatePermission()` (main.ts:1951):

```
bypass -> always proceed, never prompts
plan   -> never proceeds (defensive default; callers should short-circuit earlier)
auto   -> proceeds unless there is no existing grant for this scope+target, then prompts once
edits  -> filesystem.write proceeds without asking; everything else asks
ask    -> always asks
```

A prompt pauses the run on a real promise: `promptForPermission()`
(main.ts:1554) emits `{ kind: "permission_request", request }` on the stream,
registers a resolver in `pendingPermissionPrompts: Map<id, resolver>`, and
waits. The renderer answers via `metis-permissions:respond`, which calls
`respondToPermissionPrompt()` (main.ts:1577). Two fail-closed properties
worth keeping: no active stream auto-denies immediately (main.ts:1560), and
no answer within `PERMISSION_PROMPT_TIMEOUT_MS = 5 * 60_000` (main.ts:1551)
also denies. An "Always" verdict calls `requestPermission()` (main.ts:1633),
which writes a `PermissionGrant` so the same scope+target is never asked
again under `auto`.

`PermissionScope` (`runtime-contracts.ts:13-20`) declares seven values:
`filesystem.read`, `filesystem.write`, `network.provider`, `network.web`,
`process.spawn`, `mcp.invoke`, `notifications.send`. I checked which of these
are actually enforced anywhere (a real `gatePermission({ scope: ... })` call
site), not just declared:

| Scope | Enforced today? | Where |
| --- | --- | --- |
| `filesystem.write` | Yes | main.ts:8716 (chat path), main.ts:3804-ish equivalents in the build path |
| `process.spawn` | Yes | `maybeRunRequestedProjectCommand`, main.ts:4342 |
| `network.web` | Yes | (browser-check / fetch gates) |
| `filesystem.read` | **No live gate.** Granted once, up front, when the user picks a folder or file through a native OS dialog (`addProjectResource`, main.ts:1804-1823, or `selectProjectWorkspace`), then checked as a standing grant by `assertMetisFilePathAllowed`. No code path ever calls `gatePermission({ scope: "filesystem.read" })` mid-run. |
| `mcp.invoke` | No enforcement site | Declared, unused |
| `notifications.send` | No enforcement site | Declared, unused |
| `network.provider` | Implicit (a configured provider key is the gate) | Not via `gatePermission` |

This matters directly for tool design: **reads have never gone through the
in-run ask/deny ceremony.** The existing mental model is "you already said
yes when you attached this folder." Section C.1 below has to decide whether a
model-driven `read_file` should introduce the *first* live `filesystem.read`
gate in the app, or keep the existing "attach = trust" model. I argue for the
latter, with reasoning.

The one existing hard, unconditional path-containment check, independent of
permission mode entirely, is `assertMetisFilePathAllowed()` (main.ts:2000),
used today only by the Graph View document viewer (`readMetisFile` /
`writeMetisFile`). It resolves the target path and requires it to sit inside
either the granted write workspace or a granted read-only resource, via
`isPathInside()` (main.ts:1979: `resolve()` both sides, then an exact match
or a case-insensitive prefix compare against the parent path **with a
trailing separator appended**, which matters, see C.1). This runs regardless
of `PermissionMode` and throws on violation. It is the right shape for tool
argument validation; the new tools should call something built the same way,
not reinvent it.

### 1.4 What "project-tool" capability exists, and the honest state of command execution

- `buildProjectSnapshot()` (main.ts:2175): a **read-only survey**, not a
  readable tool. Walks up to 80 entries, depth capped at 3, skips
  `node_modules`/`.git`/`dist`/`build`/`.next`/`out`
  (`snapshotIgnoredDirs`), returns paths and sizes only, no file content. Run
  once per turn for prompt context, not callable mid-loop.
- `readExistingProjectFiles()` (main.ts:5743): a **bulk dump**, not a
  targeted read. Walks the whole tree (depth 2, `EDIT_CONTEXT_MAX_FILES = 12`
  files, `EDIT_CONTEXT_EXTENSIONS` allowlist, a 1500-char-ish per-file
  truncation and a total-byte cap, main.ts:5735-5739) and stuffs everything
  into one prompt for the "edit existing project" stage. There is no
  "read this one file, on demand, mid-turn" primitive anywhere.
- `ensureStaticPreview()` / `serveStaticFile()` (main.ts:4414/4434): a real
  local HTTP server for the verification browser check, loopback-only. Its
  own path check is weaker than `isPathInside` (see C.1).
- `runCommandOperation()` (main.ts:4260) is the **one safe-subprocess
  pattern that exists**: `execFileAsync` (promisified `execFile`, **never**
  a shell), `windowsHide: true`, an **8 second timeout**, a 1MB output
  buffer cap, stdout/stderr trimmed to 4000 characters
  (`trimCommandOutput`, main.ts:4407). This is the pattern to extend, not
  replace.
- `maybeRunRequestedProjectCommand()` (main.ts:4305) is **the entire
  command-execution surface area in the product today**, and it is much
  narrower than "run a command": `projectCommandRequest()` (main.ts:4390)
  regex-sniffs the **user's own prompt text** for phrases like "run the
  tests," and if (and only if) it matches, runs exactly
  `npm run test --if-present` (or `build` or `lint`, three fixed scripts,
  nothing else), gated on `process.spawn` through `gatePermission`, skipped
  if there is no `package.json`, skipped entirely in `plan` mode. **No model
  ever chooses the command.** `docs/AGENT_CAPABILITY_RESEARCH.md` says this
  outright: "General-purpose user-approved terminal execution is still
  future work." I confirmed it by grepping every `spawn(`/`execFile(`/`exec(`
  call site in main.ts: the only ones are this npm-script runner, the
  internal `node --check` syntax verifier, and MCP server process spawning
  (`connectMcpToolset`/`probeMcpServer`, which launch a **user-installed
  package's own declared command**, a different trust boundary entirely).
  There is no general `run_command` capability anywhere in this codebase
  today, model-directed or otherwise.
- **Zero git integration.** I grepped for `spawn("git"`, `execFile("git"`,
  `simple-git`, `isomorphic-git`, `git init`, `git stash`, `git commit`
  across main.ts and `package.json`'s dependencies: nothing. `git` is a
  string that appears only in doc prose and as an unused reserved
  `AgentOperationKind` value. Section C.3's git safety net is a genuinely
  greenfield design, not a wrapper around something that partially exists.

### 1.5 Three path-containment implementations (and one live bug)

Investigating "how does Metis stop a path from escaping its folder" turned
up three separate implementations, not one:

1. `isPathInside()` (main.ts:1979): resolve both, exact match or
   case-insensitive prefix match **with a trailing separator appended** to
   the parent before comparing. Correct: this stops `C:\proj` from wrongly
   matching a sibling `C:\projEvil`.
2. `fullArtifactPath()` (main.ts:3957): same idea, independently
   re-implemented for the build pipeline's file writer, also with the
   trailing-separator fix. Returns `null` (not a throw) on violation; the
   caller (`writeGeneratedFileSet`, main.ts:3992-4004) just silently
   `continue`s past that one file.
3. `serveStaticFile()`'s inline check (main.ts:4438-4439):
   `resolve(root, "." + pathname)` then `target.toLowerCase().startsWith(root.toLowerCase())`,
   **with no trailing separator**. This is weaker, and it is not
   hypothetical: `resolve()` collapses `..` segments, so a request for
   `/../projEvil/secret` resolves to a sibling directory whose name simply
   starts with the same characters as `root`, and the naive `startsWith`
   check would pass it. In practice this endpoint only serves a generated
   project's own preview over loopback, so the blast radius today is small,
   but it is a real, currently-shipping inconsistency, not a theoretical
   concern I invented for this doc.

None of the three resolve symlinks (confirmed: zero uses of `realpath`
anywhere in main.ts). For a human-picked folder or a model-suggested
filename inside a fenced code block, that has been a low-value gap. For a
model that can issue hundreds of tool calls autonomously, it is worth closing
properly (see C.1).

`safeRelativeFilePath()` (main.ts:3636) is the other half of the existing
containment story: a pre-filter on path **strings** (before they are even
resolved) used on model-suggested filenames extracted from prose. It rejects
null bytes, drive letters (`:`), a leading `/`, `..` anywhere in the string,
and requires the extension to be in a 17-entry allowlist (`generatedFileExtensions`,
main.ts:3597: css/cjs/html/js/json/jsx/md/mjs/svg/toml/ts/tsx/txt/webmanifest/xml/yaml/yml,
notably no `.py`, `.env`, `.sh`, `.ps1`). This is the closest existing
precedent for validating a string a model handed Metis as a path, and the new
tools should reuse its philosophy even where they relax specifics (a real
coding agent legitimately wants to write `.py` or `.gitignore`).

---

## 2. Design stance

Four opinions that shape everything below, stated up front so the rest of
this document reads as applying them rather than arguing for them
piecemeal:

1. **One loop, not two.** P10.2 already proved the shape (prompt-based
   directive, parse, execute, feed back, re-invoke, capped). The new design
   generalizes its directive envelope and reuses its loop mechanics for
   built-in tools and MCP tools alike, rather than building a second,
   competing tool-calling system. Section B is explicit about the migration.
2. **Containment is an invariant, not a permission-mode behavior.** Whether
   a path is *in bounds* is decided once, structurally, the same way
   regardless of `ask`/`auto`/`bypass`. Permission mode governs whether an
   in-bounds action needs a human's yes; it never decides what counts as
   in-bounds. This mirrors `assertMetisFilePathAllowed` exactly.
3. **Every tool call becomes a real, permanent, structured `AgentOperation`,**
   streamed live, never just a prose timeline line. This closes the P10.2
   gap in 1.2.3 and is what lets the existing operation timeline, filters,
   and (per `docs/FABLE_PLANS.md` section 20) future grouped-chip rendering
   just work without renderer changes for the kinds that already exist.
4. **Small local models are a hard constraint on the whole feature, not an
   edge case to patch around.** The owner watched 4B-class models collapse
   under stacked instructions. The answer is not a cleverer prompt; it is
   gating the feature to models that can actually carry it, and proving the
   rest later with real live tests, the same culture the rest of this repo
   already uses (`docs/DRILL_PLAN.md`'s "NEEDS LIVE TEST" tags everywhere).

---

## A. The tool set

The instinct with a feature like this is to port Claude Code's whole tool
belt. That is wrong for a v1 here for a concrete reason: every tool is prompt
weight (it competes for space and attention against the plan, the style
reference, the steering log, and the ask_user instructions already stacked
into `stagePrompt`) and every tool is attack surface (a new path argument to
contain, a new failure mode to fail soft on, a new thing a confused small
model can misuse). The set below is the smallest one that turns "generate
blind, hope, regenerate blind" into "look, act, check, and know it worked."

| Tool | Purpose | Permission scope | Op kind emitted |
| --- | --- | --- | --- |
| `read_file` | See a file before touching it | `filesystem.read` (contained-read, see below) | `context_load` |
| `list_files` | Find files without guessing | `filesystem.read` | `context_load` |
| `edit_file` | Targeted fix, not a full rewrite | `filesystem.write` | `file_edit` |
| `write_file` | Create/overwrite a whole file | `filesystem.write` | `file_create` / `file_edit` |
| `run_command` | Actually run something | `process.spawn` | `command` |
| `verify_project` | Trigger the pipeline's own checks early | `process.spawn` (see below) | `command` + `browser_check` |

Deliberately **not** in v1, with reasons, because the task is to argue for
the smallest sufficient set, not the most complete one:

- **A dedicated search/grep tool.** `list_files` + `read_file` cover "find
  the thing" for the project sizes this pipeline already targets (the
  existing snapshot caps at 80 entries). A real content-search tool needs
  its own regex-safety and result-size design; defer to phase 4 once there
  is evidence the cap is actually hit.
- **`delete_file`.** Destructive, and rarely the right lever for "test and
  fix": an unwanted file is a `write_file` of empty content or, better, a
  human decision. Deletion through the model is exactly the kind of
  irreversible action the "Prohibited" tier of any sane permission model
  reserves for a human. Defer.
- **A git tool exposed *to the model*.** The safety net in section C.3 is
  Metis-owned infrastructure the model never touches directly. Giving the
  model `git commit`/`git branch` as callable tools is a different, later
  feature (`docs/AGENTIC_ROADMAP.md` section 4 already lists "Git worktree
  isolation" as future work) and mixing it into this design conflates two
  trust boundaries that need to stay separate, see the run_command allowlist
  discussion in C.2.
- **An interactive/computer-use browser tool.** `verify_project` already
  hands the model a real console-error-and-screenshot check. A tool that
  lets the model click around a live page is the computer-use class of
  feature `docs/AGENT_CAPABILITY_RESEARCH.md` already flags as later work.
  Defer.
- **Folding the community MCP registry into this tool roster by default.**
  Unify the *engine* (one parser, one loop, see section B), but keep MCP
  tool *availability* exactly as opt-in as it is today
  (`mcpToolsEnabled`). A model should not gain a random user-installed
  MCP server's tools just because the agentic loop turned on.

### Schemas

All six share one JSON envelope (see section B for why): the model replies
with `{"tool_call": {"name": "<tool name>", "arguments": {...}}}` and nothing
else. What follows are the `name` values and their `arguments`/return shapes.

**`read_file`**

```json
{"tool_call": {"name": "read_file", "arguments": {
  "path": "src/App.tsx",
  "start_line": 1,
  "end_line": 400
}}}
```

- `path` required, relative to the workspace root. `start_line`/`end_line`
  optional; omitted means "whole file, subject to the cap below."
- Returns to the model: `{ ok: true, path, content, truncated, total_lines }`
  or `{ ok: false, error }`.
- Cap: a new `TOOL_READ_MAX_CHARS = 40_000` constant, deliberately smaller
  than `METIS_FILE_READ_MAX_BYTES = 200_000` (main.ts:1987), the cap the
  Graph View's human-facing file viewer uses. That cap protects an IPC
  payload rendered in a UI panel; this one re-enters the **same prompt**
  that already carries the plan, the frontend output, and the steering log,
  so it needs to be tuned for token budget, not panel size.
- Failure shape: outside the workspace or a secrets pattern (see C.4) ->
  `{ ok: false, error: "path is outside the permitted workspace" }` (never a
  thrown exception the run has to catch specially, exactly the pattern
  `writeMetisFile` already uses at main.ts:2060-2074: failures are values,
  not exceptions, so a bad tool call degrades to "the model saw an error
  string and can try something else," never a crashed run).
- Wraps: a new containment check built like `isPathInside`/`assertMetisFilePathAllowed`
  (see C.1) plus a plain `readFile`.

**`list_files`**

```json
{"tool_call": {"name": "list_files", "arguments": {"path": ".", "depth": 2}}}
```

- Returns: `{ ok: true, root, entries: [{ path, kind, bytes? }], truncated }`.
- This is `buildProjectSnapshot()`'s walker (main.ts:2181-2216) made callable
  on any contained subpath, repeatedly, mid-loop, instead of running once at
  session start over the whole root. Same skip-dirs, same entry cap philosophy.

**`edit_file`** (targeted replace, not a whole-file rewrite)

```json
{"tool_call": {"name": "edit_file", "arguments": {
  "path": "src/App.tsx",
  "find": "function OperationIcon({ kind }...) {\n  if (kind === \"file_edit\"...",
  "replace": "function OperationIcon({ kind }...) {\n  if (kind === \"tool_call\"...",
  "replace_all": false
}}}
```

- `find` must match **exactly once** in the current file content unless
  `replace_all: true`. This is a direct, deliberate borrow of the exact
  contract the Edit tool in this very environment uses (`old_string`/
  `new_string`, unique-match-required). The reason to copy it rather than a
  line-range or unified-diff format: line numbers drift and models
  hallucinate them, and unified diffs carry a lot of format syntax (`@@`
  hunks, context lines, leading `+`/`-`) for a small model to reproduce
  correctly, exactly the "instructions stack and it collapses" failure mode
  the owner already observed. Exact-substring match is the least amount of
  new format a model has to learn correctly to do the single most common
  repair action (fix this one thing without regenerating the file).
- Failure shape: `find` not present -> `{ ok: false, error: "no match found" }`;
  `find` matches N > 1 times without `replace_all` -> `{ ok: false, error: "matched 3 times, pass replace_all or a more specific find" }`.
  Both are recoverable: the model sees the error and can retry with a more
  specific string, bounded by the same call cap as everything else, never an
  infinite retry loop.
- Requires the file to already exist; `edit_file` never creates one (that is
  `write_file`'s job, so "which tool creates files" stays unambiguous).
- v1 does **not** require a prior `read_file` call on the same path before
  allowing an edit (Claude Code's own Edit tool does enforce read-before-edit).
  That is a reasonable v2 hardening (stops a model editing blind against
  stale assumptions about the file's content) but it adds state to track
  across an otherwise stateless loop; leave it out of v1 and revisit once
  there is real usage data on whether models actually edit-without-reading.
- Returns: `{ ok: true, path, added_lines, removed_lines }`, computed the
  same way `writeTextArtifact` already computes them (main.ts:3981-3987).

**`write_file`**

```json
{"tool_call": {"name": "write_file", "arguments": {
  "path": "src/newThing.ts",
  "content": "...",
  "create_only": false
}}}
```

- `create_only: true` fails if the file already exists, guarding against an
  accidental blind clobber of something the model never looked at.
  `create_only: false` (default) matches the existing pipeline's behavior of
  overwriting freely.
- Path validation reuses `safeRelativeFilePath`'s structural checks (no null
  bytes, no drive letter, no leading `/`, no `..`) but swaps its 17-extension
  **allowlist** for a small **denylist** (`.exe`, `.dll`, `.so`, `.bat`,
  `.cmd`, `.scr`, plus whatever else earns a place through review) for this
  tool specifically. Reason for the difference: `safeRelativeFilePath` guards
  *prose parsing* of untrusted model output where a wrong guess about intent
  is the risk; `write_file` is an explicit, structured, model-declared call
  where legitimately wanting to write `.py`, `.sh`, or `.gitignore` is normal
  for a real coding agent, and blocking it defeats the point of the tool.
  Nothing written this way auto-executes, which is why a light denylist is
  sufficient instead of another allowlist.
- Returns and operation kind: identical shape to `edit_file`'s, `file_create`
  when the file did not exist, `file_edit` when it did (matches
  `operationsForProject`'s existing `artifact.kind === "file_create"` split,
  main.ts:4115-4127).

**`run_command`**

```json
{"tool_call": {"name": "run_command", "arguments": {
  "command": "npm",
  "args": ["run", "test", "--if-present"],
  "cwd": ".",
  "timeout_ms": 60000
}}}
```

- `args` is always an array, never a single shell string, and execution is
  always `execFileAsync` (never a shell), exactly `runCommandOperation`'s
  existing pattern. See C.2 for why the allowlist for v1 is narrower than
  this schema technically permits.
- `cwd` resolves relative to the workspace root and must pass the same
  containment check as every path argument; default is the workspace root.
- `timeout_ms` is a model-suppliable **request**, clamped server-side to a
  hard maximum (see C.2 for numbers); the model cannot ask for an unbounded
  run.
- Returns: `{ ok: true, exit_code, stdout, stderr, duration_ms }` (stdout/
  stderr trimmed via the existing `trimCommandOutput`, main.ts:4407) or
  `{ ok: false, error }` for a spawn failure/timeout/denied-by-allowlist,
  same fail-soft shape as `callMcpToolForRun`.
- Operation kind: `command`, identical shape to what `runCommandOperation`
  already produces, so `OperationRow`/`OperationIcon`/`OperationMeta`
  (App.tsx:7700-7789) render it with zero renderer changes.

**`verify_project`**

```json
{"tool_call": {"name": "verify_project", "arguments": {}}}
```

- No path or command arguments at all, on purpose: this tool must never
  become a second `run_command` wearing a friendlier name. It takes nothing
  and does exactly one thing: calls the **existing**
  `verifyGeneratedProject(root, files)` (main.ts:4006) and, when there is an
  `index.html`, the existing preview-and-browser-check path, early, at the
  model's own request, instead of only automatically after every stage
  finishes.
- This is the smallest possible new capability for the largest owner-stated
  win: zero new execution surface (it is 100% code that already ships and is
  already trusted), and it directly answers "check its own work mid-turn."
- Returns: the same `{ verified, detail, consoleErrors, screenshotPath, commands }`
  shape `verifyGeneratedProject` already returns, as tool-result text.
- Permission scope: I argue this does **not** need its own fresh
  `process.spawn` prompt distinct from `run_command`'s, because its command
  surface is 100% fixed and non-model-chosen (unlike `run_command`, where
  the model picks the argv). Treat it as riding on the standing trust
  already established by the `filesystem.write` grant that let the project
  be written in the first place: if Metis was allowed to write these files,
  it is allowed to run the same fixed check on them it already runs
  automatically. `run_command`, where the model chooses what runs, is the
  one that earns its own prompt.

---

## B. The loop

### One directive envelope, generalized from P10.2

P10.2's `{"mcp_tool_call": {"server": ..., "tool": ..., "arguments": ...}}`
becomes:

```json
{"tool_call": {"name": "<tool name>", "arguments": {...}}}
```

`name` is either a built-in tool from section A, or, when MCP tools are also
enabled for this run, a namespaced MCP tool reference (`"mcp:<server>/<tool>"`),
so the model learns **one** JSON shape regardless of which kind of tool it is
calling, and Metis runs **one** parser and **one** loop instead of two
competing mechanisms. Concretely, `parseMcpToolCall()` generalizes into
`parseToolCall(output)`, keeping its exact tolerant-extraction strategy
(whole trimmed reply, then a fenced block, then first-`{`-to-last-`}`), just
matching `tool_call` instead of `mcp_tool_call`. The chat path's existing
P10.2 wiring (main.ts:8957-9098) migrates onto the same parser and dispatch
table in the same phase this ships (see E), rather than the two ever
diverging. `parseMcpToolCall`'s old shape can stay accepted as a legacy
alias for one release if there is any concern about an in-flight prompt
still expecting it; it is not load-bearing to keep it forever.

A per-run **dispatch table** is built once, before the first stage call,
from whatever is actually available: the fixed built-in tools (filtered by
model capability tier and `PermissionMode`, see D) plus, if
`mcpToolsEnabled` is on, the connected MCP toolsets exactly as
`connectMcpToolsetsForRun()` already produces them. `mcpToolPromptBlock()`'s
text generalizes to list both groups in the same one-line-per-tool format it
already uses.

### Where it plugs into the pipeline

Inside `runOrchestratedStages()`'s per-stage loop, right after the existing
`<ask_user>` handling and before the critic loop (main.ts:7657-7693 today).
Sketch, not a diff:

```ts
let attempt = await callStageWithFallback(stage.chain, stagePrompt, ...);
// existing <ask_user> handling stays exactly as is
...
if (toolsEnabledFor(stage, attempt.ref, permissionMode)) {
  attempt = await runToolLoop({
    initialAttempt: attempt,
    stagePrompt,
    stage,
    stream,
    permissionMode,
    scope,             // same directiveScopeKey used for cancellation
    runBudget,         // shared across the whole run, see below
  });
}
// existing critic loop runs on whatever runToolLoop returns, unchanged
```

`runToolLoop` itself is the P10.2 loop, generalized:

```ts
async function runToolLoop(args): Promise<{ output: string; failed: boolean }> {
  let { output } = args.initialAttempt;
  let prompt = args.stagePrompt;
  while (true) {
    throwIfCancelled(args.projectPath);                 // same guard runOrchestratedStages already uses
    if (args.runBudget.callsUsed >= TOOL_MAX_CALLS_PER_RUN) break;
    if (Date.now() - args.runBudget.startedAt > AGENTIC_RUN_WALL_CLOCK_BUDGET_MS) break;

    const requested = parseToolCall(output);
    if (!requested) break;                               // no tool asked for -> this IS the final answer

    emitTimeline(args.stream, timelineText(`Running ${requested.name}(${summarizeArgs(requested.arguments)})...`));

    const gate = await gatePermission({ stream: args.stream, mode: args.permissionMode,
      scope: scopeForTool(requested.name), target: args.stage.label, projectPath: ... , detail: ... });
    const outcome = gate.proceed
      ? await executeTool(requested.name, requested.arguments, args)   // builds a real AgentOperation
      : { ok: false, text: "Permission denied.", operation: deniedOperation(requested) };

    args.runBudget.callsUsed++;
    emitStream(args.stream, { kind: "operation", operation: outcome.operation });
    metisOperations.push(outcome.operation);              // survives into SessionRun.operations like every other op

    prompt += toolResultBlock(requested, outcome, args.runBudget);      // same append-only growth as P10.2
    const reattempt = await callStageWithFallback(args.stage.chain, prompt, ...);
    output = reattempt.output;
  }
  return { output, failed: false };
}
```

### Caps, timeouts, and how it ends

One run-wide budget, not a separate counter per stage, because stages are
already sequential and a per-stage cap that resets each time would let a
5-stage run (plan/frontend/functional plus up to 2 repair passes) spend up to
5x a per-stage limit without any single number describing the real worst
case. A run-wide counter, threaded alongside the existing `directiveScopeKey`
scope, is one thing to reason about and one thing to show the user.

| Constant | Proposed value | Why |
| --- | --- | --- |
| `TOOL_MAX_CALLS_PER_RUN` | 12 | Room for read, list, edit, verify a few times over across 3-5 stages without being effectively unbounded |
| `AGENTIC_RUN_WALL_CLOCK_BUDGET_MS` | 600,000 (10 min) | A hard ceiling on the tool-loop portion of a run, separate from however long the generations themselves take |
| Read/list/edit/write per-call timeout | 10,000 ms | Generous headroom on purpose: this repo itself lives under OneDrive, and OneDrive-synced folders can have real, non-trivial file I/O latency during a sync; a timeout tuned only for a bare local SSD would misfire on the exact kind of folder this project itself is stored in |
| `verify_project` timeout | 45,000 ms | Composes a command run plus a headless browser load; give it room to do both |
| `run_command` default timeout | 60,000 ms, model may request up to 120,000 ms (clamped) | Real build/test commands routinely exceed the existing 8s internal syntax-check timeout; a 60s default with a firm ceiling avoids either starving a real test run or letting one request an unbounded one |

Termination is one of exactly five things, and each is a distinct,
user-visible line, never a silent stop:

1. **The model just answers.** No `tool_call` parses out of the reply. This
   is the common case and needs no special handling, identical to P10.2 today.
2. **Call cap reached.** Inject the same closing instruction P10.2 already
   uses verbatim ("The tool-call limit for this turn is reached, answer the
   user now without requesting another tool"), do exactly one more re-invoke
   with no tool block advertised, and stop regardless of what comes back.
3. **Wall-clock budget exceeded.** Stop with a visible timeline line
   ("Tool budget reached, wrapping up with what I have") rather than
   truncating output mid-stream.
4. **Permission denied.** Feed the denial back as a normal tool-result error
   (fail soft, exactly like a timed-out MCP call today) so the model can
   adapt or give up gracefully, **except** in `plan` mode, which never enters
   the tool loop at all, mirroring the existing plan-mode short-circuit that
   already skips project-tools entirely (main.ts:7740-7743).
5. **Cancellation.** `throwIfCancelled(projectPath)` at every loop boundary,
   and every tool's underlying operation (the `execFile` call, even a
   filesystem call where practical) registers under the run's existing
   `directiveScopeKey` `AbortController` set (main.ts:7369-7397) so a
   mid-call Stop press interrupts it immediately instead of waiting out the
   per-call timeout.

### Streaming stays coherent

Two things make "the user sees it happen, not a frozen screen" true without
inventing new plumbing:

1. **Emit intent before executing.** The instant `parseToolCall` succeeds,
   before the tool runs at all, `emitTimeline(stream, timelineText("Running read_file(...)")))`
   fires. This is a small, genuine improvement over P10.2 today, which only
   reports success/failure *after* the call resolves (main.ts:9078); the
   loop above emits both.
2. **Emit the real result as a real operation on completion.** Every tool
   call becomes an `AgentOperation` with the correct existing kind
   (`context_load`/`file_edit`/`file_create`/`command`/`mcp_call`) pushed
   through `emitStream(stream, { kind: "operation", operation })`, the exact
   mechanism `applyStreamEventToTurn` (App.tsx:602-607) already merges into
   the live turn incrementally as events arrive, and the exact mechanism
   `OperationRow`/`OperationIcon` (App.tsx:7700-7765) already knows how to
   render, filter, and expand, **today, for every one of these kinds**,
   with zero renderer changes required. This is the direct fix for the P10.2
   gap noted in 1.2.3.

The call itself is still one blocking `await` from the perspective of that
one turn's token stream, same as a single provider call or an MCP tool call
already is today; that is an accepted, precedented tradeoff, not a new
problem this design introduces. What changes is that the *rest* of the
timeline keeps moving around it (the "Running X..." line appears
immediately, prior operations are already rendered, the Stop button stays
live), instead of the screen looking frozen for the length of a timeout.

Not required for v1, but worth flagging as a clean, low-cost extension: a
dedicated `tool_call` stream event mirroring `stage_call`'s existing
start/complete two-phase shape (`docs/FABLE_PLANS.md` section 26,
`{ id, stageId, provider, model, promptPreview, status: "start"|"complete"|"failed" }`)
would give tool calls the same live side-chat card treatment model calls
already get. The timeline-text-then-operation two-step above already
satisfies "visible, not frozen" without it, so it can wait.

Separately, `docs/FABLE_PLANS.md` section 20 already states an intent to
visually group consecutive operations into one collapsible chip ("Read 3
files, ran 1 command"). This design does not need to implement that (it is a
renderer concern, and App.tsx has another active writer right now), but
every tool call emitting a properly-kinded `AgentOperation` is exactly the
data that grouping needs, so the two efforts compose for free once both land.

---

## C. Safety

This is the part the owner cares about most, so it gets the most opinion.

### C.1 Path containment

Consolidate the three implementations found in 1.5 into **one** function
every new tool (and, ideally, `serveStaticFile`, though that is out of scope
for this doc since it means touching main.ts) calls, with no exceptions:

```ts
async function resolveContainedPath(rawPath: string, root: string): Promise<string> {
  const target = resolve(root, rawPath);
  const resolvedRoot = resolve(root);
  const withSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  const inBounds =
    target.toLowerCase() === resolvedRoot.toLowerCase() ||
    target.toLowerCase().startsWith(withSep.toLowerCase());
  if (!inBounds) throw new ContainmentError("outside workspace");

  // Symlink hardening: resolve() alone does not follow symlinks, and no
  // existing check in this codebase does either (confirmed: zero uses of
  // `realpath` anywhere in main.ts today). A symlink placed inside the
  // workspace that points outside it would pass every existing check. This
  // matters more for a model issuing hundreds of autonomous calls than it
  // ever has for a human-picked folder, so the new tools close it: resolve
  // the real path (fs.realpath, falling back to `target` if the path does
  // not exist yet, e.g. a write_file creating something new) and re-run the
  // same bounds check against it.
  const real = await realpathOrSelf(target);
  if (!real.toLowerCase().startsWith(withSep.toLowerCase()) &&
      real.toLowerCase() !== resolvedRoot.toLowerCase()) {
    throw new ContainmentError("path escapes workspace via symlink");
  }

  if (matchesSecretDenylist(target)) throw new ContainmentError("blocked: looks like a secrets file");
  return target;
}
```

Failure behaviour: **never throws out to the run.** Every tool's executor
wraps this call and turns a thrown `ContainmentError` into that tool's
ordinary `{ ok: false, error }` result shape, exactly the pattern
`writeMetisFile` already uses (main.ts:2060-2074: a security failure is a
value the caller can show inline, never an unhandled rejection). A denied
path is not a crashed run; it is a tool result the model can see and adapt
to, or fail on gracefully after the call cap is reached.

### C.2 `run_command` policy

This is the dangerous one, and the honest starting point is: **Electron's
`sandbox: true` setting, used today only for the hidden preview-verification
`BrowserWindow` (main.ts:4519-4527), provides zero protection here.** That
setting sandboxes a renderer's Chromium JS context. `run_command` executes
via `child_process` from the trusted Node **main** process (the same process
that already has full filesystem and `child_process` access per
`docs/SECURITY.md`), completely outside any Electron sandbox boundary. I
confirmed the main window itself (`createWindow`, main.ts:11183) sets
`contextIsolation`/`nodeIntegration` (main.ts:11197-11198) but never sets
`sandbox` at all, which is irrelevant to this question either way. Nothing
about Electron's process model makes a shell command "safer" to run. The
mitigations below are real, but they are policy, not sandboxing, and that
distinction should stay explicit in any UI copy about this feature.

The policy, opinionated:

- **No shell, ever.** `execFileAsync(command, argsArray, ...)`, never
  `exec()`, never `shell: true`. This is already the existing
  `runCommandOperation` pattern; the new tool must not regress it. Note the
  one place in this codebase that *does* use `shell: true`
  (`connectMcpToolset`, main.ts:2771, retrying a bare `npx` spawn on
  Windows) is spawning a **user-installed package's own declared command** at
  install-time-approved trust, a different trust boundary entirely from a
  model-issued, per-call command string. Do not let that precedent leak into
  `run_command`'s implementation by copy-paste.
- **Allowlist, not denylist, and a narrow one at v1.** A denylist has to
  anticipate every dangerous binary in advance and will always miss one; an
  allowlist only has to get the *safe* set right. Ship v1 scoped to
  **running an already-declared `package.json` script**, structurally
  identical to `maybeRunRequestedProjectCommand`'s existing constraint
  (`npm run <test|build|lint> --if-present`, main.ts:4380-4387), just
  model-invoked instead of prompt-regex-invoked, plus a bare `node --check
  <file>` for syntax validation (what `verifyGeneratedProject` already runs).
  That is a small, well-understood, already-battle-tested risk surface. Do
  **not** ship "run any binary with any argv" in v1; that is a categorically
  bigger surface for one document to bless in one pass, and the phased plan
  in section E treats broadening it as a distinct, later decision that needs
  its own review once there is real usage data.
- **`git` is deliberately excluded from the model's allowlist, on purpose,
  even in later phases that broaden it.** Metis's own safety net (C.3) relies
  on git refs the model must not be able to touch. If `run_command` could
  invoke `git`, a model could run `git update-ref -d refs/metis/pre-run-<id>`
  or `git gc --prune=now` and quietly delete its own undo point, which
  defeats the entire safety net from inside the very tool the safety net
  exists to contain. Metis's internal use of git for snapshotting and the
  model's `run_command` tool must stay two separate trust boundaries,
  permanently, not just until a broader allowlist ships.
- **`cwd` is always resolved through `resolveContainedPath` (C.1)**, default
  to the workspace root, never permitted outside it.
- **Env scrubbing, not `{...process.env}`.** The MCP server spawn path
  (main.ts:2768) passes the full parent environment plus the package's own
  declared vars, which is correct there: MCP servers are the user's own
  explicitly-installed, install-time-permissioned packages. A model-issued
  `run_command` is untrusted-input-driven and gets a **minimal explicit
  allowlist** instead: `PATH`, `TEMP`/`TMP`, `SystemRoot` (Windows) or
  `HOME` (POSIX), and whatever the specific allowlisted toolchain strictly
  needs, never a blanket copy. Every provider secret this app manages
  (`docs/SECURITY.md`'s "Secrets" section: keys read via `readSecrets()` or,
  for the `"environment"` storage tier, actual process env vars like
  `ANTHROPIC_API_KEY`) must be structurally absent from that child's
  environment, not merely "not needed by npm scripts in practice."
- **Output**: reuse `trimCommandOutput`'s existing 4000-character cap
  exactly, both for what goes back into the model's prompt and what the
  human-facing operation row stores. No new constant, no reason to diverge
  from a pattern already proven in the same file.
- **Behaviour per `PermissionMode`**, layered on top of the allowlist check
  (an allowlist miss is never a prompt, it is a flat denial, in every mode
  including `bypass`, because `bypass` means "stop asking me," not "let the
  model run arbitrary binaries"):

  | Mode | Behaviour |
  | --- | --- |
  | `plan` | Tool loop never runs; `run_command` is unreachable |
  | `ask` | Every call prompts, every time, no exceptions |
  | `edits` | Still prompts (matches today: `edits` only auto-approves `filesystem.write`, main.ts:1966) |
  | `auto` | Prompts once per distinct command signature (binary + args, not per call), then remembered via the existing `PermissionGrant` mechanism, same as any other `process.spawn` grant today |
  | `bypass` | No prompt, but the allowlist check still runs unconditionally; an allowlist violation is a flat `{ ok: false }`, not something bypass mode waives |

### C.3 A git safety net

Before the *first* write-capable tool call of a run (`edit_file`,
`write_file`, or `run_command`; never for read-only tools), Metis snapshots
the workspace so anything the run does can be undone. Zero git integration
exists in this codebase today (confirmed in 1.4), so this is designed from
first principles, using the plain `git` CLI via `execFileAsync` (no new
dependency; `package.json` today has no git library and the app's own
dependency list is already deliberately lean).

**Case 1: the folder is already a git repository.**

1. Probe once per run (cheap, cache the result): `git --version` succeeds
   and `git rev-parse --is-inside-work-tree` succeeds in the workspace root.
2. `git stash create` (**not** `git stash push`). This is the right
   primitive specifically because it creates a real commit object
   representing the current index and working tree **without touching
   either** (nothing is stashed away, nothing pops, the user's own
   in-progress edits are completely undisturbed) and simply prints the
   resulting commit hash. If the tree is fully clean, `git stash create`
   prints nothing; in that case just record `git rev-parse HEAD` instead,
   since there is nothing uncommitted to capture.
3. `git update-ref refs/metis/pre-run-<runId> <hash>`. The `refs/metis/`
   namespace is deliberate: it sits outside `refs/heads/` and `refs/tags/`,
   so it never appears in the user's normal branch list, is never touched by
   an ordinary `git push`, and is unambiguously Metis's own bookkeeping, not
   the user's history.
4. Record `{ runId, projectPath, baseRef: hash, createdAt }` in Metis's own
   store (the same `metis-store` JSON pattern every other piece of run
   metadata already uses), so revert does not depend solely on git's own
   reflog retention window.
5. **One snapshot per `SessionRun`**, taken at the first write-capable call,
   not one per tool call or per repair pass. A run's repair passes are
   already treated as sub-steps of one run everywhere else in this pipeline
   (`REPAIR_PASS_LIMIT`); the safety net should match that unit, both so
   `refs/metis/*` stays legible and so revert always means "back to before
   this whole run," not some partial mid-run state.

Revert offers two granularities, because "undo everything" and "undo just
this file" are both real needs: `git reset --hard refs/metis/pre-run-<runId>`
for the whole run, or `git diff refs/metis/pre-run-<runId> -- <path>` /
`git checkout refs/metis/pre-run-<runId> -- <path>` for one file, surfaced
next to that file's operation row.

**Case 2: the folder is not a git repository** (no functional `git`, or
`git rev-parse --is-inside-work-tree` fails).

I argue **against** silently running `git init`. Turning a plain folder into
a git repository is a structural, sticky side effect: a `.git` directory the
user never asked for, that persists forever, and that can conflict with a
repository the user deliberately creates there later. It is exactly the kind
of "did something behind my back" behaviour the owner said makes him nervous
about shipping this at all. Instead:

- **Default: a copy-based snapshot.** Before the first write-capable call,
  recursively copy the current workspace (skipping the same
  `node_modules`/`.git`/`dist`/`build`/`.next`/`out` that `buildProjectSnapshot`
  already skips, since those are regenerable, never hand-authored) into
  `dataPath("agentic-snapshots", <runId>)`, the same app-managed-storage
  pattern `dataPath("generated-projects", ...)` already uses elsewhere.
  Revert copies it back.
- **This copy is a genuine full backup, not a capped one.** Do not reuse
  `buildProjectSnapshot`'s 80-entry cap here: that cap exists for prompt
  token economy, and a safety net that silently drops files past entry 80
  is worse than no safety net, because it *looks* complete and is not. If
  the workspace is large enough that a full copy is a real concern (propose
  warning above roughly 500MB), say so up front rather than quietly doing a
  partial backup: "This project is large (X MB); the safety snapshot may
  take a moment and use disk space. Continue?"
- **Offer `git init` as an explicit, opt-in, one-time choice**, never a
  silent default: "This folder isn't a git repo yet. Metis can initialize
  one for stronger version history. [Not now] [Initialize git]" This treats
  it the way the top-level rules here treat any standing configuration
  change: something the user decides, not something that happens as a side
  effect of an unrelated action.

**Fail closed.** If snapshotting itself fails for any reason (`git` present
but `stash create`/`update-ref` errors, or the copy fails partway, disk full,
permissions), the write-capable tools do not run for that turn at all. Fall
back to the existing blind whole-file build pipeline (section 1.1), which
has no dependency on any of this, and say so plainly on the timeline:
"Couldn't create a safety snapshot, so I'm skipping direct file edits this
run and using the regular build pipeline instead." A tool loop that can
write files without a working undo point is exactly the scenario that
justifies the owner's fear; refusing to run is the correct default, not an
edge case to special-case away.

**What the UI should say**, concretely, matching this repo's own plain,
no-em-dash voice:

- Before the first write-capable call: "Metis is about to let the model edit
  files directly. Snapshotting the current state first so anything it does
  can be undone." (git case) or the copy-case equivalent naming a local
  backup instead of a repo.
- Attached to the run afterward: a persistent "Undo this run" action on that
  conversation turn, visible until dismissed or superseded by a later run's
  snapshot.
- After a revert: "Reverted N file(s) to how they were before this run,"
  linking to a diff view (the Graph View file viewer already has the
  plumbing to show file content; reuse it rather than building a second one).

### C.4 Secrets

**Hard block, not a permission prompt**, checked inside the same
`resolveContainedPath` function every tool already calls (C.1), so it is
structurally impossible for a new tool to forget the check, rather than a
convention every call site has to remember separately.

Reasoning for hard block over "ask the user": a permission prompt only works
as informed consent if the human understands what is actually being
requested. "Allow read of `.env`?" said plainly is an easy no. A model can
reach the same content through indirection just as easily, faster than a
human reviewing a stream of approvals can reliably catch every one: a
`run_command` piping a secrets file through `grep`, a `read_file` on a
relative path that walks outside the obvious project files, or several
individually-innocuous reads that reconstruct something sensitive across
turns. This also matches the codebase's own existing philosophy exactly:
`assertMetisFilePathAllowed` does not ask permission per read either; it is
a hard boundary that permission-mode ceremony sits on top of, never a thing
permission mode itself decides.

Denylist (case-insensitive, checked against both the basename and the
resolved relative path):

- `.env`, `.env.*`, with the **same explicit exception** `buildProjectSnapshot`
  already carves out for `.env.example` (main.ts:2196): a template file with
  no real secret in it is legitimately useful project context.
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, `id_dsa` (the
  public `.pub` counterparts are fine).
- `credentials*.json`, `secrets*.*`.
- `.npmrc`, `.pypirc` (both can carry registry auth tokens).
- The entire `.git` directory, which is not a new rule but an explicit
  restatement of one that already exists for a different purpose
  (`EDIT_CONTEXT_SKIP_DIRS`, main.ts:5738, already skips it): `.git/config`
  can carry credential-helper tokens, and none of these tools have any
  legitimate reason to read or write inside `.git` directly regardless.

Be honest about the limit of this list, in the document and in any UI copy
that references it: a filename denylist cannot catch a secret hardcoded
inside an otherwise-ordinary source file (`read_file` on a `.ts` file that
happens to contain a pasted API key is not something any filename pattern
stops). The two things that actually make provider keys safe are structural,
not this list: this app's own keys never live in a project file in the first
place (`docs/SECURITY.md`: keys live in `safeStorage`/`metis-store` or an
environment variable, never written into a workspace), and `run_command`'s
env scrubbing (C.2) means even a command that goes looking cannot find them
in its own process environment. The denylist is defense in depth for the
*obvious* cases, not a claim of completeness, and this document should not
oversell it as one.

---

## D. The model-facing prompt

The prompt block mirrors `mcpToolPromptBlock()`'s exact density (one line
per tool, name, one-clause description, minimal args) because that shape is
already shipping and already proven not to confuse the models that get it
today:

```
You can call these tools:
- read_file(path, start_line?, end_line?): read a file in the project
- list_files(path, depth?): list files and folders under a path
- edit_file(path, find, replace, replace_all?): replace an exact snippet in an existing file
- write_file(path, content, create_only?): create or overwrite a whole file
- run_command(command, args, cwd?): run an allowed project command (e.g. npm run test)
- verify_project(): re-run the project's syntax and preview checks now

To call a tool, reply with ONLY this JSON object and nothing else:
{"tool_call": {"name": "<tool name>", "arguments": { ... }}}
The tool result will be given back to you so you can continue. At most 12
tool calls total this turn. If no tool is needed, answer normally.
```

Note this is deliberately the **same closing sentence structure** P10.2
already ships (main.ts:2892), just with the tool list and the cap number
changed. Reusing proven phrasing here is not laziness, it is the one part of
this whole feature that has already survived contact with real models in
this exact codebase.

### Coping with small models: gate the feature, do not write a simpler prompt for it

The owner's own live testing already answered this question: 4B-class local
models collapse once instructions stack. The fix is not a cleverer, shorter
prompt tuned for small models; a stripped-down tool prompt is still one more
instruction layer stacked on top of the METIS.md block, the style reference,
the steering log, and the ask_user instructions that `runOrchestratedStages`
already assembles into `stagePrompt` before the model even sees the task
(main.ts:7566-7648). Adding anything there for a model that already
struggles with the existing stack makes it worse, not better.

**Ship tools for cloud models only in v1.** Concretely: enable the tool
block only when the stage's resolved provider is not `ollama` (or more
precisely, `toolsEnabledFor()` checks `attempt.ref.provider !== "ollama"`).
A local Ollama stage gets no tool block appended at all, byte-identical to
today. This is not a permanent ban on local models; it is the same "prove it
with a live test before shipping it broadly" discipline the rest of this
repo already applies to every other feature (`docs/DRILL_PLAN.md`'s "NEEDS
LIVE TEST" convention). Once there is a specific, minimal, live-tested tool
prompt shape that a specific local model tag handles reliably, add that
model tag to an explicit allowlist, the same way `KNOWLEDGE_EMBED_MODEL =
"nomic-embed-text"` is a specific, tested, hardcoded model choice rather than
"any local model that claims to support embeddings." Do not generalize to
"local models" as a category until a specific model has earned it.

**The tool block is appended last, once, per stage prompt build**, after
every other block, so it is the most recent thing the model reads before
being asked to act. And critically, once the loop starts iterating, the
prompt only ever **grows by appending one tool exchange at a time**
(`prompt += toolResultBlock(...)`, exactly P10.2's existing
`sessionPrompt +=` pattern, main.ts:9086-9092), never by rebuilding the
whole instruction stack from scratch each iteration. So a model three tool
calls into a loop is not re-reading the style reference and the steering log
three times over; it is reading the original stack once, plus a short,
linearly-growing tail of what it asked for and what happened. That property
is not new work this design has to build; it falls out of copying P10.2's
existing append-only growth exactly, which is one more reason to keep this
loop's mechanics identical to that precedent instead of doing something
architecturally different that would have to re-earn this property.

---

## E. Phased plan

Each phase is intentionally shippable and testable on its own via the CLI
harness described in the task (`npm run cli -- build "..." --project <path>`,
not yet present in this repo as of this investigation, being built alongside
this document). Every phase after 0 strictly requires the previous one.

**Phase 0: read-only foundation.**
Ship `read_file` and `list_files` only. Cloud models only (section D). Wired
into `runOrchestratedStages` stages only, not the chat path (which keeps its
existing separate P10.2 loop untouched this phase, unified in phase 1). New
flag `agenticToolsEnabled`, boolean, default `false`, same store-key pattern
as `mcpToolsEnabled`. No git safety net needed yet; nothing is written.
CLI test: run a build with the flag off and confirm the operations list is
byte-identical to today (regression check), then with the flag on against a
project fixture and assert `context_load` operations appear with real read
paths, and that the run still completes and verifies exactly as before.

**Phase 1: `verify_project`, and the git safety net lands (before anything writes through this loop).**
Add `verify_project`. Build the full C.3 infrastructure now, both the
existing-repo and not-a-repo cases, even though nothing yet needs to revert
anything, so phase 2 starts against an already-proven safety net instead of
racing to build one under pressure once writes are live. Also: migrate the
chat path's P10.2 wiring onto the generalized `parseToolCall`/dispatch table
from section B, retiring the parallel mechanism. CLI test: run against a
scratch git fixture, assert a `refs/metis/pre-run-*` ref exists after a run
that triggers a snapshot path (force one for the test even though nothing
writes yet), assert revert restores byte-identical content; repeat against a
non-repo fixture and assert the copy-based snapshot restores identically.

**Phase 2: `edit_file` and `write_file`, the real unlock.**
Gated to `PermissionMode` `edits`/`auto`/`bypass` (never `plan`; `ask`
prompts every call per C.2's table generalized to filesystem scope).
Mandatory precondition, fail closed: if the C.3 snapshot cannot be taken, the
write-capable tools do not run this turn, full stop, falling back to the
existing blind pipeline. CLI test: an existing small project fixture,
prompt like "rename X to Y everywhere," assert `file_edit` operations with
correct `added_lines`/`removed_lines`, assert the safety ref exists, assert
a forced revert matches the fixture's original content exactly.

**Phase 3: `run_command`, narrow.**
Ship scoped exactly to "run an already-declared `package.json` script" plus
`node --check`, per C.2's opinion, not a general allowlist yet. Default
`PermissionMode` behaviour per C.2's table. CLI test: a fixture with a
deliberately failing `npm test`, prompt asks to fix it, assert a `command`
operation with the real exit code appears in the run's operations, assert
the loop terminates either on success or cleanly on cap/budget, never hangs.

**Phase 4: explicitly deferred, not forgotten.**
MCP tool-roster unification into the same advertised list as built-ins (the
*engine* unifies in phase 1; the *roster* stays separate longer, per
section A's reasoning). Local/small-model tool support, once a specific
model earns a specific tested prompt. A broader, configurable `run_command`
allowlist beyond package scripts. A dedicated search/grep tool.
`delete_file`. Model-invoked git operations as their own tool, kept
permanently distinct from Metis's own safety-net git usage (C.2). An
interactive/computer-use browser tool beyond `verify_project`'s fixed check.
Several of these are already named as future work in
`docs/AGENTIC_ROADMAP.md` (git worktree isolation, managed sub-agents); this
phase is where this design's deferred items and that roadmap's existing
items are the same list.

---

## Summary of opinions taken, for anyone skimming

- Reuse P10.2's loop shape; generalize its JSON envelope from
  `mcp_tool_call` to `tool_call` so built-in tools and MCP tools share one
  parser, one loop, one cap, instead of two systems.
- Six tools, not more: `read_file`, `list_files`, `edit_file`, `write_file`,
  `run_command`, `verify_project`. `edit_file` is exact-substring replace,
  not diffs or line numbers, because small models handle that format best.
- Every tool call becomes a real `AgentOperation`, streamed live, fixing the
  one concrete gap found in the existing MCP loop (it never actually
  populates the `mcp_call` operation kind the renderer already fully
  supports).
- Path containment is one function, checked the same way regardless of
  permission mode, hardened with symlink resolution the existing three
  implementations all lack.
- `run_command` ships last, narrowest, allowlisted to package scripts only,
  explicitly excludes `git` forever (not just until a broader allowlist
  ships), and its risk is named honestly rather than declared solved by
  Electron settings that do not apply to it.
- A git (or copy-based) safety net is a hard precondition for any
  write-capable tool, fails closed if it cannot be established, and never
  silently `git init`s a folder the user did not ask to become a repository.
- Secrets are a hard block at the containment layer, not a permission
  prompt, because informed consent requires understanding the request and a
  model can phrase around a human's attention faster than that.
- Tools are gated to cloud models entirely in v1. The fix for small-model
  instruction collapse is scope, not a cleverer prompt.

## The single biggest risk

`run_command`, even after every mitigation above. It is the only tool whose
blast radius is the host machine's own privileges rather than the project
folder: `docs/SECURITY.md` already states the app's own threat model boundary
plainly, "it isn't a sandboxed execution environment for arbitrary untrusted
code," and nothing in this design changes that boundary, it only decides how
carefully to approach it. Electron's `sandbox: true` (used today only for the
hidden preview-verification window) genuinely does not apply here: it
sandboxes a renderer's JS, and `run_command` executes via `child_process`
from the trusted Node main process, a completely different boundary. And
`run_command` is the one tool that can close the loop within a single turn:
a `write_file` call followed by a `run_command` call in the same loop
iteration means the model can execute code that same untrusted turn just
authored, which no other tool in this set can do on its own. The allowlist,
no-shell, env-scrub, timeout, and permission-gate mitigations in C.2 are
real and worth shipping, but they are policy on top of an unsandboxed
process, not a substitute for one. The honest long-term fix is real OS-level
isolation (job objects on Windows, containers elsewhere), which
`docs/AGENTIC_ROADMAP.md` already names as future work and this document
does not attempt to design. Until that exists, the right posture is exactly
what section E does: ship `run_command` last, keep its allowlist small on
purpose, and resist widening it just because nothing has gone wrong yet.
