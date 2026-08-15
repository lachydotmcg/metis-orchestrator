# Model catalogue: what is current, and what will bite you

Last refreshed 2026-08-14 against provider documentation and live model-list
endpoints. 97 models verified; every id below came from a provider's own docs or
its `/models` endpoint, never from a blog post or recall.

This file exists because a wrong model id is not a lint error — it is a 404 in a
user's face mid-run, and this repo has already shipped that bug once.

---

## What was wrong before this refresh

**`deepseek-chat` and `deepseek-reasoner` were retired on 2026-07-24 and Metis
was still sending them.** Eleven call sites across `main.ts` and `App.tsx`.
Every DeepSeek route in v1.2.0 was pointing at a dead id. Fixed: DeepSeek's
first-party API now exposes exactly two strings, `deepseek-v4-pro` and
`deepseek-v4-flash`, both floating aliases with no dated snapshot. Reasoning
stopped being a separate model card and became a request parameter
(`thinking.type`).

**Opus 5 was missing entirely.** The library offered Opus 4.8 as Anthropic's
flagship. Same price ($5/$25), lower independent score. Single biggest gap.

Also corrected: Grok 4.5 → 4.6 (same price, same 500K context, better), Qwen3.7
Max → 3.8 Max, GLM-4.6 → 4.7, added Gemini 3.7 Flash and 3.5 Flash-Lite.
Removed GPT-5.1 and GPT-5 mini from the curated library — the original GPT-5
family retires 2026-12-11 and does not belong in a library four months out.

---

## Footguns, in rough order of how quietly they fail

1. **Anthropic dateless ids from 4.6 onward are PINNED SNAPSHOTS, not evergreen
   pointers.** `claude-opus-5` is frozen; appending a date 404s. Pre-4.6 is the
   exact opposite — the dated snapshot is canonical and the bare form floats.
   Two conventions in one provider.
2. **Retired Grok ids silently redirect rather than 404.** `grok-4-fast-*`,
   `grok-code-fast-1`, `grok-3` and others now serve and **bill** `grok-4.3`
   while returning 200. Worse than the bug this app already shipped, because
   nothing surfaces. Delete the strings; do not leave them to alias.
3. **Refusals from Opus 5 / Fable 5 / Sonnet 5 return HTTP 200** with
   `stop_reason: "refusal"` and possibly empty content. Code that reads
   `content[0]` unconditionally crashes on a successful response.
4. **One thinking config does not fit all Claudes.**
   `thinking:{type:"enabled",budget_tokens}` 400s on Fable 5 / Opus 5 / Sonnet 5
   / 4.8 / 4.7 — those want `{type:"adaptive"}` plus `output_config.effort`.
   Haiku 4.5 is the inverse and takes only the old form. Fable 5 400s on **any**
   explicit thinking config. `temperature`/`top_p`/`top_k` 400 on Opus 4.7+ at
   non-default values.
5. **`gemini-3.1-pro-preview` needs the `-preview` suffix** on the Developer
   API. Vertex lists it bare. Keep a per-surface id column rather than one
   string.
6. **GLM display names are not ids.** The pricing page renders `GLM-5.2`; the
   API accepts only `glm-5.2`. Precisely the display-name-as-id bug already
   shipped once here.
7. **OpenRouter dot-vs-dash, and dates dropped.** `claude-opus-4-8` becomes
   `anthropic/claude-opus-4.8`; `claude-haiku-4-5-20251001` becomes
   `anthropic/claude-haiku-4.5`. Only major-version-only ids survive a straight
   prefix.
8. **DeepSeek's OpenRouter alias is a different model.**
   `deepseek/deepseek-v4-flash` is pinned to an older snapshot; matching
   first-party behaviour needs `deepseek/deepseek-v4-flash-0731`.
9. **`gpt-oss-*` and `gpt-5.3-codex` do not support Chat Completions on
   OpenAI's own API** — Responses only. Route gpt-oss through Ollama or Groq.
10. **Groq 400s on `messages[].name`.** A multi-agent orchestrator setting a
    per-speaker name hits a hard error. Also unsupported: `logprobs`,
    `logit_bias`, `top_logprobs`; `n` must be 1.
11. **Ollama bare tags resolve to surprising sizes.** `gemma4` → e4b, not 12b.
    `nemotron-3-nano` → the 30b. Always store the fully-qualified tag. And
    **`-cloud` suffixed tags are Ollama-HOSTED, not local** — they break the
    local-first promise silently.
12. **Vendor prefixes are per-route namespaces, not vendor names.** MiniMax is
    `minimax/` on OpenRouter and `minimaxai/` on NVIDIA.

---

## Deprecations to watch

| Date | What |
|---|---|
| 2026-08-16 | Groq's Llama 3.3 70B and 3.1 8B — after this Groq has zero Meta models |
| 2026-08-26 | OpenAI Assistants API |
| 2026-10-23 | `gpt-4.1-nano`, `o1`, `o3-mini`, `o4-mini`, `gpt-4-turbo`, `gpt-3.5-turbo`. The 4.1 family is **not** uniformly safe: nano dies, base survives |
| 2026-12-11 | The entire original GPT-5 family plus `o3`/`o3-pro` |
| 2027-01-20 | `gpt-realtime`, `gpt-audio`, all 4o audio/realtime |

**Already dead — live 404s if present:** the whole `gemini-2.0-*` family, all
`gemini-2.5-*-preview-*` snapshots, `claude-opus-4-1-20250805`,
`claude-sonnet-4-20250514`, `claude-3-7-sonnet-20250219`,
`claude-3-5-haiku-20241022`, every DeepSeek model on Groq.

**Anthropic's deprecation table is easy to misread.** For active models the
column reads "Not sooner than <date>" — a *minimum support floor*, not a
scheduled retirement, with 60 days' email notice before any real one. Do not
auto-hide on it. Haiku 4.5's floor is 2026-10-15 and it is the only cheap-fast
Claude in the library, so it is keep-and-monitor rather than drop.

---

## The architectural fix: stop hardcoding

Four providers publish live model lists that would have prevented the DeepSeek
bug outright, and the best one is free:

- **`GET https://openrouter.ai/api/v1/models`** — **no auth**, 411 models, and
  it returns pricing, context, `supported_parameters`, `expiration_date` **and**
  independent Artificial Analysis benchmark scores in a single call. Fetch at
  startup, cache, and grey out anything whose `expiration_date` has passed.
- **`GET http://localhost:11434/api/tags`** — the `name` field *is* the id, and
  a local id cannot 404 because the weights are on disk. Populate the entire
  Ollama section from this and treat any hardcoded list as the
  "Ollama not running" fallback.
- **`GET https://api.deepseek.com/models`** — two entries, OpenAI-shaped.
- **`GET https://api.anthropic.com/v1/models`** — returns a `capabilities` tree
  with effort levels and thinking types, genuinely useful to a router. Two
  cautions: `max_input_tokens` is nullable and the docs' own example returns
  `0`, so treat 0/null as unknown; and it returns **no pricing**.

Neither Alibaba nor Z.ai publishes one. Those two stay hardcoded, or come via
OpenRouter.

**This is the real fix.** A hardcoded catalogue is a thing that goes stale
silently between releases, which is exactly what happened here. `remoteModelCatalog`
already exists as the mechanism — it just points at a registry repo that is
hand-updated. Pointing part of it at OpenRouter's free endpoint would make the
picker self-maintaining.

### Built, 2026-08-15

The two no-auth sources are wired in. `fetchLiveCatalogModels()` in
`src/electron/main.ts` fetches both from the **main** process (the renderer does
no outbound network — see `isRegistryFetchUrl`), each with its own 2-second
timeout and each failing independently and silently, and `refreshModelCatalog`
merges the result over the bundled list through `mergeCatalogModels`. The
mapping itself is pure and lives in `src/shared/model-catalogue.ts`, so the
offline suite (`18-model-catalogue`, 33 assertions) exercises the shipped code
rather than a copy of it.

Three decisions worth keeping:

- **An OpenRouter entry produces an OpenRouter route only.** Never a
  synthesised direct one. This is the "same model, three different ids" footgun
  above turned into a rule: their ids are not safely invertible, so inventing a
  first-party route from one manufactures exactly the 404s this exists to
  prevent.
- **Pricing is all-or-nothing.** Half a price displays a total that is *wrong*
  rather than incomplete, and the usage display cannot say "half known". A
  genuinely free model is `{in: 0, out: 0}`; an unparseable one is absent.
- **Expiry drops the model at merge, not at the UI**, so nothing downstream has
  to remember to check. An *unparseable* date counts as no expiry — hiding a
  working model is worse than showing a dead one, because a dead one gives the
  user an error they can read.

The two keyed sources (DeepSeek, Anthropic) are not wired in. Adding them means
reading a stored API key inside a catalogue refresh, which is a bigger change to
the key-handling path than the value justifies while OpenRouter already carries
both providers' current line-ups.

---

## Not adopted, and why

- **An `ollama` brand key** for local models in the library. Worth doing —
  GPT-OSS 20B, Qwen3.5 9B, Qwen3-Coder 30B and EmbeddingGemma all belong in a
  local-first app's library — but the brand enum has no local key, and filing
  them under `openai` would route them at `api.openai.com` where `gpt-oss-*`
  does not support Chat Completions at all. That is a guaranteed failure, so the
  brand change has to come first. Left as a deliberate follow-up rather than
  smuggled into a catalogue refresh.
- **`claude-mythos-5`** — invitation-only. A user without access gets exactly
  the not-found failure this document exists to prevent.
- **`gpt-5.3-codex`** — Responses API only, would 400 on Metis's
  chat-completions path.
- **`gemini-3.6-pro`** — appeared in one OpenAI-compatibility doc page and on no
  models page, pricing page or deprecation table. Treated as a doc artifact.

One conflict resolved rather than shipped both ways: NVIDIA's docs list models
its live `/v1/models` endpoint does not return. The live endpoint was trusted and
the NVIDIA route for DeepSeek V4 Pro dropped entirely. NVIDIA currently serves no
Qwen models despite its own reference page saying otherwise.
