# Oracle: speculative inference for pinned local chat

Contributor-facing reference for the Oracle system as it actually exists in
`src/electron/main.ts`, `src/electron/preload.cts`, `src/renderer/global.d.ts`
and `src/renderer/ui/App.tsx`. Written from the code, not the pitch - every
name below is a real function, constant, or store key you can grep for.

## Overview

Oracle speculatively runs a pinned local Ollama model ahead of the user
finishing their prompt, so that by the time they hit send, the model is
already warm and - sometimes - the answer already exists. It is:

- **Off by default.** Gated behind the `prewarmEnabled` store key
  (`DEFAULT_PREWARM_ENABLED = false` in `App.tsx`), flipped from the Settings
  → Experiments panel. `main.ts` re-checks the same store key inside
  `prewarmModel` and `draftModel` as defense-in-depth, even though the
  renderer is expected to gate the IPC call itself.
- **Local-only, always.** Every Oracle fetch targets
  `OLLAMA_BASE_URL = "http://127.0.0.1:11434"`. It never talks to a cloud
  provider, even if a non-local model id is passed in - Ollama just 404s and
  the call fails soft like any other failure.
- **Pinned-chat only.** Oracle only applies to a pinned model
  (`input.modelOverride`) on the direct-chat path. Auto Router runs and the
  build/orchestration pipeline are untouched.
- **Side-effect-free.** No conversation record, no session-run record, no
  stage/stream event, no file write. Toggling `prewarmEnabled` back off
  leaves zero trace behind.

## The ML principle (brief)

An LLM call has two phases: **prefill** (the prompt tokens are run through
the model once, in parallel, to build the KV cache) and **decode** (tokens
are generated one at a time, each attending back over that cache). Prefill
on a long prompt is the dominant cost of time-to-first-token for a short
answer - the model can't emit token 1 until the whole prompt has been
prefilled.

Because attention is causal (token *N* only attends to tokens *1..N*), the
KV cache for a prompt prefix is reusable for any longer prompt that shares
that exact prefix - this is Ollama's prompt cache. If Oracle prefills a
model with a prompt string, and the real request later sends the *same*
string (or that string plus a small suffix), Ollama's cache hits: prefill
work is skipped for everything already cached, and only the new suffix
needs prefilling.

This is why Oracle cares so much about sending the *exact assembled prompt*
during speculation, not just the raw text the user is typing - see "The
assembled-prompt invariant" below.

## The three layers

Oracle is three cooperating pieces, all defined around `main.ts:8446-8721`:

### 1. Prewarm - `prewarmModel(model, draft, context)`

A discarded `/api/generate` call with `options: { num_predict: 1 }` - it
asks Ollama to load the model and prefill the prompt into its KV cache, then
throws the one generated token away. Debounced from the composer on a
**~400ms** pause since the last keystroke (`App.tsx`, the warm `useEffect`).
Guards:

- `PREWARM_MIN_DRAFT_LENGTH = 8` - trivially short drafts aren't worth it.
- `PREWARM_DEDUPE_WINDOW_MS = 3000` - the same `(model, draft)` hash (tracked
  in `lastPrewarm`) won't be re-warmed within 3s.
- `prewarmAborts: Map<string, AbortController>` - one in-flight warm per
  model; a second warm for the same model while one is running is skipped
  (not queued).
- `PREWARM_FETCH_TIMEOUT_MS = 10000` - hard timeout via `AbortController`.

Fails soft and silent in every case: never throws, resolves `void`.

### 2. Draft preview - `draftModel(model, draft, context)`

A sibling to `prewarmModel`, but it runs a **full** generation
(`options: { num_predict: PREWARM_DRAFT_MAX_TOKENS }`, currently `2048`) and
returns the text instead of discarding it. Debounced separately from the
composer on a slower **~800ms** pause (`App.tsx`, the draft `useEffect`) so
it only fires on a real typing pause, not every warm.

- Same `PREWARM_MIN_DRAFT_LENGTH` / `prewarmEnabled` guards as prewarm.
- Its own dedupe map (`lastDraft`) and its own in-flight tracker
  (`draftAborts: Map<string, { controller, hash }>`), deliberately separate
  from `prewarmAborts` so a warm and a draft for the same model can run
  concurrently without starving each other.
- **Latest wins**: if the prompt changes while an older draft is still
  generating, the in-flight request is aborted and a fresh one starts,
  rather than letting a stale draft run to completion for a prompt that no
  longer exists.
- `PREWARM_DRAFT_FETCH_TIMEOUT_MS = 90000` - a full generation needs far
  more headroom than the 1-token warm.
- `PREWARM_DRAFT_MAX_TOKENS = 2048` - sized so a thinking model's `<think>`
  block plus its answer can both finish naturally; 768 was tried first and
  cut off mid-answer (`done_reason: "length"`, never servable).
- **No temperature override.** The draft is generated with the model's
  default sampling - the same sampling the real streaming call uses - so a
  cached draft is a legitimate sample of the model's answer, not a
  shortcut fake.
- The response is split via the existing `splitThinkTaggedOutput` helper so
  `<think>...</think>` content is separated into `thoughts`, shown only in
  the renderer's Oracle popover, never inserted into the chat transcript or
  composer.
- **Caching for instant serve**: the result is only stashed in
  `servableDraft` when it was generated from an *assembled* prompt (raw-draft
  prompts can never hash-match a real run) **and** `payload.done_reason ===
  "stop"` (finished naturally, not truncated by the `num_predict` cap).

### 3. Instant serve - the gate in `runSession`

Inside `runSession`'s pinned-chat path (`main.ts:~7631-7666`), just before
invoking the provider:

```ts
const servedDraft =
  override && provider === "ollama" && !chatImages && (await readStoreValue<boolean>("prewarmEnabled", false))
    ? takeServableDraft(model, sha256(sessionPrompt))
    : null;
```

The gate is conservative and stacked: **pinned model** (`override` is set,
so Auto Router runs never qualify) + **local Ollama provider** + **no image
attachments** + **`prewarmEnabled` flag on** + **exact sha256 match** between
the real assembled `sessionPrompt` and the cached draft's prompt hash. Only
all five together produce a hit.

`takeServableDraft(model, promptHash)` (`main.ts:8625`) is a one-shot claim:
it checks `SERVABLE_DRAFT_TTL_MS = 3 * 60 * 1000` (3 minutes) for
expiry, requires `servableDraft.model === model && servableDraft.promptHash
=== promptHash`, and clears `servableDraft` on any successful claim so the
same draft can never be served twice.

On a hit, `runSession` emits `thought_delta` / `message_delta` exactly as a
real streaming call would, records an audit line ("Oracle served the
pre-drafted response for an exact prompt match."), builds a `providerResult`
with `ttftMs` measured as the actual elapsed serve time, and sets
`run.oracleServed = true`. Any mismatch - even a single differing character
anywhere in the assembled prompt - falls through to the normal
`invokeProvider` call, which still benefits from whatever prefix the O3
warm/draft calls already primed in Ollama's cache.

## The assembled-prompt invariant

This is the load-bearing design decision in the whole system, and the
easiest thing for a future change to silently break.

**The problem**: if Oracle warms/drafts using only the raw text the user is
typing, that string is *not* the prompt the real call sends. `runSession`
builds a much larger `sessionPrompt` via `sessionProviderPrompt(...)` -
system framing, project snapshot, METIS.md, conversation context, retrieved
knowledge, etc. - wrapped around the user's text. Warming the raw draft only
keeps the model resident in memory (still useful); it does nothing for
prefill time, because the real call's prompt has a completely different
prefix and Ollama's KV cache still misses on it.

**The fix**: `assembleChatPrewarmPrompt(draft, context)` (`main.ts:8471`)
rebuilds that same assembled prompt for the speculative path, calling the
same pipeline `runSession` calls: `decidePolicy` → `applySessionRouteOverrides`
→ `resolveWritableProjectWorkspace` → `isFastLaneEligible` →
`buildProjectSnapshot` / `loadProjectMetisFile` / `recentConversationContext`
/ `retrieveKnowledgeForPrompt` → `sessionProviderPrompt(...)`. Both
`prewarmModel` and `draftModel` call this first and send the assembled
result (falling back to the raw draft if assembly fails or `context` is
omitted).

The `PrewarmContext` (`{ conversationId?, projectPath? }`) the renderer
passes through `metisPrewarm.warm`/`draft` is what lets this rebuild happen
at all - without it, `assembleChatPrewarmPrompt` returns `null` immediately
and both functions fall back to warming/drafting the raw text.

**Maintenance warning, verbatim from the code comment at `main.ts:8459`**:
`assembleChatPrewarmPrompt` "MUST stay in lockstep with the pinned branch of
runSession (~7509-7605): any text drift between the two shifts the shared
prefix and silently costs cache hits - if you change one, change the
other." If you touch how `sessionProviderPrompt` is called in `runSession`'s
pinned path, mirror the change here or Oracle quietly degrades back to
warm-only (no error, no crash - the cache prefix just stops matching, and
you will not be told).

Known, accepted small divergences between the two (documented in the same
comment block):

- Uses `resolveWritableProjectWorkspace` (pure, read-only) instead of
  `resolveActiveProjectWorkspace`, so a background warm can never trigger a
  filesystem permission grant prompt.
- `decidePolicy` runs without a preset.
- Knowledge retrieval queries the in-progress draft rather than the final
  submitted prompt (the retrieved chunks rarely change across the last few
  keystrokes).

## Safety and honesty

- **Fail-soft everywhere.** `prewarmModel` and `draftModel` never throw out
  of themselves; every failure path (Ollama unreachable, model missing,
  aborted, malformed JSON, timeout) is swallowed and resolves
  `void`/`null`. `assembleChatPrewarmPrompt` itself returns `null` on any
  error rather than propagating.
- **Local-only, never cloud** - hardcoded to `OLLAMA_BASE_URL`
  (`127.0.0.1:11434`); there is currently no code path where Oracle sends a
  prompt fragment to a cloud provider.
- **Side-effect-free** - no `appendAudit` call, no conversation write, no
  stage/stream event, no file write, from either `prewarmModel` or
  `draftModel`. The only audit line Oracle ever produces is the
  `"session.provider"` line written by `runSession` itself when a serve
  actually happens.
- **A real send always wins.** `abortOracleSpeculativeWork()`
  (`main.ts:8605`) is called at the very top of the pinned-chat invoke path,
  before anything else: it aborts every entry in `draftAborts` and every
  entry in `prewarmAborts`, then clears both maps. This exists because
  Ollama serializes requests per model - an in-flight 2048-token
  speculative draft would otherwise queue a real send behind it. This was
  measured directly: 13390ms time-to-first-token on a send that landed
  while a draft was still running (`main.ts:8601`, comment on
  `abortOracleSpeculativeWork`). The aborted fetches fail soft inside their
  own `try/catch`, so aborting never surfaces an error anywhere.
- **Exact-match-only serving is a legitimate sample, not a shortcut.** The
  serve gate requires a byte-identical sha256 match on the fully assembled
  prompt, and the draft that gets served was generated by the same model
  with the same default sampling the real streaming call would have used
  (no temperature override - see `draftModel`). So an Oracle-served answer
  is not a cached "close enough" guess dressed up as a real answer; it is
  the actual output the model would have produced for that exact input, just
  computed slightly earlier. The renderer labels it honestly rather than
  hiding the fact: `App.tsx`'s `run.oracleServed` check renders "Oracle
  answered instantly, `{ttftMs}`ms" instead of the normal "first token
  `{ttftMs}`ms" line - never presented as identical to an unassisted run.

## The IPC + flag surface

**Main-process functions** (`main.ts`):
- `prewarmModel(model: string, draft: string, context?: PrewarmContext): Promise<void>`
- `draftModel(model: string, draft: string, context?: PrewarmContext): Promise<{ text: string; thoughts?: string } | null>`
- `assembleChatPrewarmPrompt(draft: string, context?: PrewarmContext): Promise<string | null>`
- `abortOracleSpeculativeWork(): void`
- `takeServableDraft(model: string, promptHash: string): { text: string; thoughts?: string } | null`

**IPC channels** (registered `main.ts:9578` / `9582`):
- `metis-prewarm:warm` → `(model, draft, context?) => prewarmModel(model, draft, context)`
- `metis-prewarm:draft` → `(model, draft, context?) => draftModel(model, draft, context)`

**Preload bridge** (`src/electron/preload.cts:176-185`), exposed as
`window.metisPrewarm`:
```ts
contextBridge.exposeInMainWorld("metisPrewarm", {
  warm: (model, draft, context?) => ipcRenderer.invoke("metis-prewarm:warm", model, draft, context) as Promise<void>,
  draft: (model, draft, context?) => ipcRenderer.invoke("metis-prewarm:draft", model, draft, context) as Promise<{ text: string; thoughts?: string } | null>
});
```

**Renderer type** (`src/renderer/global.d.ts:157-171`) declares the same
shape on `Window.metisPrewarm?`. `PrewarmContext` is
`{ conversationId?: string; projectPath?: string }` on both sides.

**Store key**: `prewarmEnabled` (boolean), default `false`
(`DEFAULT_PREWARM_ENABLED` in `App.tsx`). Read via
`useAppStoreState("prewarmEnabled", ...)` in the renderer (composer +
Settings → Experiments toggle) and via `readStoreValue<boolean>("prewarmEnabled", false)`
in `main.ts` (`prewarmModel`, `draftModel`, and the serve gate in
`runSession`).

**`SessionRun` contract fields** (`src/shared/runtime-contracts.ts:807-834`):
- `ttftMs?: number` - time-to-first-token for the run's provider call,
  promoted from `providerResult.ttftMs`. On an Oracle serve this is the
  measured serve time (`Date.now() - providerStart`), not a fresh
  generation's real TTFT.
- `oracleServed?: boolean` - true only when the answer came from
  `takeServableDraft` rather than a fresh call to `invokeProvider`.

**Renderer consumption** (`App.tsx:5897-5900`):
```ts
if (run.oracleServed) {
  return <em>{typeof run.ttftMs === "number" ? `Oracle answered instantly, ${run.ttftMs}ms` : "Oracle answered instantly"}</em>;
}
return typeof run.ttftMs === "number" ? <em>first token {run.ttftMs}ms</em> : null;
```

The Oracle composer chip (debounce timers, `oracleActivity`, `oracleLog`,
`oracleDraft` state) lives entirely in `App.tsx` starting around line 4595
and is documented there inline; it is UI plumbing around the three
functions above, not part of the Oracle engine itself.

## Measured results

From `docs/DRILL_PLAN.md`'s O3/O4 entries: the assembled-prompt prefix match
(O3) measured **365ms, down from 1285ms** for time-to-first-token on the
warmed path. The README's public claim, from broader real-world testing
across the warm/draft/serve stack, is **4.1x to 9.5x** faster
time-to-first-token, with an unchanged prompt at send time served instantly
from the fully drafted answer. These are two separate measurements recorded
in two different places in the repo (`docs/DRILL_PLAN.md` line 71 and
`README.md` line 15) - cited here as documented, not re-derived.

The 13390ms regression these numbers do *not* include is the one O4.1 fixed:
a send that queued behind an in-flight speculative draft before
`abortOracleSpeculativeWork()` existed (see "Safety and honesty" above).

## Extending it

Documented future directions, not yet built (from `docs/DRILL_PLAN.md`):

- **O5 - cloud Oracle behind a separate paid opt-in.** Draft/warm via a
  cloud provider using the user's own key, gated behind an explicit toggle
  distinct from `prewarmEnabled` (cloud calls cost tokens and send partial
  prompts off-device, so it must never activate silently just because local
  Oracle is on). DeepSeek is the named first target for its automatic
  context caching. Would need a harder debounce than the local 400ms/800ms
  pair to avoid per-keystroke spend, plus honest cost copy in the UI.
- **B8.2 - Oracle for all cloud models, plus speculative pre-routing.**
  Two extensions: (a) the O5 cloud-prewarm idea generalized beyond
  DeepSeek (Anthropic prompt caching named as a likely next target); (b)
  while typing on Auto Router (not just a pinned model), run
  `decidePolicy`/`applySessionRouteOverrides` speculatively on the draft so
  the route is already resolved before the user hits send, and prewarm
  whichever target that resolves to.
- **B8.3 - split Oracle into its own repo/package.** The prewarm/draft/serve
  engine (this document's subject) as a standalone library, separate from
  Metis Gallery (a different, unrelated style-memory concept also flagged
  for extraction later).
- **v0.4 similarity-gated serving.** The current serve gate is exact-match
  only by design (see "Safety and honesty"). A near-miss version - serving
  a draft whose prompt is *similar but not identical* to the real one - is
  called out in `DRILL_PLAN.md`'s O4 entry as a possible v0.4, explicitly
  contingent on first having "a real confidence metric." No such metric
  exists in the codebase today; do not approximate one with a naive string
  distance without reading that constraint first, since a false-positive
  serve here would mean answering a different question than the one asked.

## What changed since v0.3 (2026-07-15 to 2026-07-17)

Everything above describes Oracle as of v0.3 (O4/O4.1). The batch-11/12 drill
round (`docs/DRILL_PLAN.md`) shipped several extensions on top of that base.
The assembled-prompt invariant and the lockstep warning still hold - every
addition below either reuses `assembleChatPrewarmPrompt`/`sessionProviderPrompt`
directly or is explicitly called out where it does not.

### Instructions now ride the same assembled prompt

`globalInstructionsPromptBlock()` (`main.ts:2073`) reads the `globalInstructions`
store key (a plain string, edited from Settings > Chat) and folds it into
`sessionProviderPrompt(...)` at all six prompt-assembly sites: chat, fan-out,
staged builds, extraction recovery, extraction repair, and edit mode. Because
Oracle's draft/warm path assembles through the exact same
`sessionProviderPrompt` call as a real run, an empty `globalInstructions`
string produces a byte-identical prompt to before it existed, and a non-empty
one is present on both the speculative side and the real side without any
separate wiring - the lockstep invariant absorbed it for free. If you add a
seventh assembly site, it needs the same block or Oracle silently diverges
from the real call again.

### Open-prewarm: warming before the first keystroke

Previously Oracle only fired from composer typing. A renderer effect now
fires one warm per conversation+model pair the moment a conversation is
opened (300ms switch debounce), with an **empty** draft. `prewarmModel` was
extended to accept an empty draft when a `conversationId` is present in its
`PrewarmContext`: it still assembles the full conversation prefix (system
framing, project snapshot, METIS.md, conversation history so far) via
`assembleChatPrewarmPrompt`, it just has no in-progress user text to append.
If assembly fails or there's no conversation id, it falls back to a plain
residency load of the model. Net effect: the first keystroke in a freshly
opened conversation can already be warm, not cold.

### Draft streaming into the popover

`draftModel` is now `stream: true` against Ollama instead of a single
blocking call, using the same accumulation and `done_reason`-gated
servable-caching rules as before - only the transport changed, not the
caching contract. An optional `onDelta` callback rides the streaming chunks
back to the renderer over a new IPC push, `metis-prewarm:draft-delta`, with
the first delta of a generation carrying `reset: true` so the renderer knows
to clear the popover rather than append to a stale draft. The renderer
subscribes via `onDraftDelta` (preload) and streams the deltas straight into
the popover's `oracleDraft` state, so the guess now visibly forms token by
token - including its `<think>` block - instead of appearing all at once.
Cloud drafts (below) stay one-shot for now; only the local Ollama draft path
streams.

### O5: cloud Oracle via DeepSeek (paid, opt-in, off by default)

A second, entirely separate function, `draftCloudModel(model, draft,
context)`, drafts from an assembled prompt through `invokeCloudProvider(...)`
using the user's own saved DeepSeek key, registered on its own IPC channel
(`metis-prewarm:draft-cloud`). It is double-gated: the renderer only fires it
when both `prewarmEnabled` **and** the new `oracleCloudEnabled` store key are
on (Experiments toggle, with explicit cost copy - drafting from a cloud model
spends real tokens on every fired draft, unlike a local warm), and `main.ts`
re-checks `oracleCloudEnabled` independently before calling out
(`main.ts:10285`) as the same defense-in-depth pattern as `prewarmEnabled`
everywhere else. There is deliberately no cloud "warm" sibling to
`prewarmModel` - a cloud warm-only call would just spend tokens for nothing,
since there's no local KV cache to prefill; DeepSeek's own automatic context
caching covers the assembled prefix instead. Cloud drafts land in the same
`servableDraft` slot as local ones, keyed by the resolved model id, and share
the abort/latest-wins behavior via `abortOracleSpeculativeWork`. The
`runSession` serve gate now also accepts a pinned DeepSeek model as a valid
serve source when `oracleCloudEnabled` is on, and attributes the source
honestly (a served cloud draft is not reported as a local one). The renderer
fires the cloud draft only on a harder 2-second pause (versus local's 800ms),
sharing the same stale-guard request id as the local draft effect so a
same-turn local and cloud draft never race each other into a stale state.

### v0.4: near-match serving (embedding-gated, with a lexical guard)

The exact-match-only design in "Safety and honesty" above still holds by
default. v0.4 adds an *additional*, separately opt-in path
(`oracleSimilarityEnabled` store key, Experiments toggle, default **off**)
that can serve a draft when the sent prompt is not byte-identical to the
drafted one but differs only cosmetically. It only runs after the exact
sha256 match already missed - it never competes with or weakens the exact
path.

The design has two stages, in order:

1. **Lexical guard (runs first, cheap).** Before any embedding call, the
   diff between the drafted prompt and the sent prompt is scanned for words
   unique to either side that match negation, undo, or number patterns
   (think "don't", "not", "instead", digits). Any such word vetoes serving
   outright, no matter how close the embedding similarity later comes out -
   a prompt that flips a negation or changes a number is exactly the case
   where a "95% similar" answer would be a wrong answer, not a close one.
2. **Divergent-tail embedding (runs only if the guard passes).** Rather than
   embedding the two full prompts, only the *divergent tails* are embedded -
   the two prompts' shared prefix is stripped first, keeping a small ~200
   character runway of shared context around the divergence point. This
   matters because the full assembled prompts (system framing, snapshot,
   history) share a huge common prefix; embedding the full strings would
   report near-100% cosine similarity between almost any two prompts in the
   same conversation, regardless of what the user actually changed. Embedding
   only the part that differs makes the similarity score actually measure
   the change, using the same local `nomic-embed` model already in the
   stack. A cosine similarity of 0.97 or higher serves the draft, one-shot,
   same as the exact-match path.

Serving is **honestly labelled**, never presented as identical to a fresh
exact-match serve: `run.oracleNearMatch` carries the similarity score through
to the renderer, which shows "Oracle answered instantly, `{ttftMs}`ms - near
match `{percentage}`%" instead of the plain "Oracle answered instantly" line,
and the audit line records the same similarity figure. Fail-soft everywhere:
if no embedding model is available, this path is simply skipped and the
normal call proceeds, exactly as if `oracleSimilarityEnabled` were off.

Known follow-ups, not yet built: a one-click "answer my exact prompt" re-run
when a near-match was served instead of an exact one, and the originally
envisioned endgame - serve the near-match instantly *and* verify with a real
background call, appending a visible correction if the two answers diverge.

### Warm-chain: prewarming the next build stage

Separately from the pinned-chat-only Oracle described above, the staged
build pipeline (Plan -> Frontend -> Functional) now fires a residency-only
prewarm for the *next* stage's model as soon as the *current* stage starts,
via `warmChainNextStage`. This is deliberately not the same as prefix
warming: the next stage's prompt depends on the current stage's not-yet-known
output, so there is no assembled prefix to send - it is `num_predict: 1` with
`keep_alive: 5m` purely to get the model resident in memory ahead of time,
skipped when the next stage would reuse the same model as the current one
(already resident, so the extra request would only queue behind real work).
Behind the same `prewarmEnabled` flag as the rest of Oracle.
