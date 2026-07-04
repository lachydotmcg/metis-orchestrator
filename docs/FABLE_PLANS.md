# Fable Plans — feature designs for Metis Orchestrator

Written 2026-07-02 by Claude Fable 5. Division of labour: this doc is the thinking; Opus/Sonnet
sessions action individual sections. Each section is self-contained enough to hand to a cold agent.
Companion doc: AGENTIC_ROADMAP.md (agentic core). This one covers product/experience features.

---

## 1. Design Seeds — creativity as infrastructure (fixes "why do models rely on ME for creativity")

**The diagnosis:** small local models aren't uncreative, they're *mode-seeking*. Ask qwen3:8b an
open question and it collapses to the statistical average: "What would you like to build?", purple
gradients, Inter font, hero-features-footer. Big models escape this because they can *choose*;
small models can't choose but they're excellent at *executing specific constraints*. So don't ask
the model to be creative — make the orchestrator the taste engine.

**The mechanism:** at plan time, Metis rolls a **design seed** — one coherent bundle:

```ts
interface DesignSeed {
  id: string;            // "brutalist-paper"
  name: string;          // "Brutalist paper"
  palette: string[];     // 4-5 hexes, hand-picked
  type: { display: string; body: string };   // real pairings, e.g. "Space Grotesk / Newsreader"
  layout: string;        // archetype: "oversized numerals, hard rules, asymmetric grid"
  motion: string;        // "instant, no easing" | "slow fades" | "springy"
  voice: string;         // copy personality: "dry, confident, short sentences"
}
```

- Ship a **seed bank of ~40 hand-curated seeds** (a JSON file; curate them once with a big model,
  then they cost zero tokens forever). Selection = seeded hash of the prompt + a reroll counter, so
  the same request re-run gives a *different* good answer, never the same slop.
- Inject the chosen seed into every stage prompt: "Design seed (non-negotiable unless the user
  specified otherwise): …".
- Show it in chat as one slim line: `Design seed: "Brutalist paper" — Space Grotesk, ink on bone,
  oversized numerals` with a small reroll icon → reroll posts a directive (bus already exists) so
  the next stage re-skins.
- This is also the real fix for "everything comes out purple": purple gradient IS the mode. Seeds
  make the mode unreachable.

Implementation: `src/shared/design-seeds.json` + `pickDesignSeed(prompt, reroll)` in main.ts +
injection in `runOrchestratedStages` stage prompts + one timeline line. Small, high leverage.

## 2. Live preview rail (no more "Open preview" shoved in your face)

Chat shows only a slim hyperlink line. The real experience moves to a **right-side preview rail**:

- After a successful build, the right rail (where the Library sits) swaps to a preview panel:
  an `<iframe>` pointed at the local preview URL (it's plain `http://127.0.0.1:PORT`, iframes are
  fine — no webview needed for v1). Header: project name, refresh, open-in-browser, close.
- **Repair passes and steering become visible**: every rewrite refreshes the iframe, so you watch
  the site fix itself mid-run. This is the single most Gurren-Lagann feature available for cheap.
- Markdown artifacts (e.g. a written report) render in the same rail as a doc view instead.
- v2 (only if iframe hits a wall): Electron `webviewTag: true` or a positioned `BrowserView`.

Implementation: new `PreviewRail` component in App.tsx; open it when a stream `project` event
carries `previewUrl`; refresh on subsequent `project` events for the same run.

## 3. Managed agents — synchronized sub-sessions on the same folder

Extends the directive bus (AGENTIC_ROADMAP §3, phase 1 shipped 2026-07-02).

- Each sub-session = an **agent identity**: `{ id, name, model, colour }` (auto-named: Nyx, Talos,
  Echo…). A roster strip shows who's active on the project.
- **File-claim ledger** on the bus: before touching files an agent posts
  `{ agentId, paths[], intent: "reworking palette", ttl }`. Claims are visible to every session as
  slim chat lines with the agent's colour dot: `● Talos claimed styles.css — reworking palette`.
- **Conflict protocol** (deterministic, no negotiation LLM needed): second claimant on an
  overlapping path either (a) waits for ttl/release, (b) narrows to disjoint files, or (c) posts a
  `merge-request` directive that the holder absorbs at its next stage boundary — same mechanism as
  user steering, so agents steer each other exactly like the user steers them.
- On release, the agent posts a **handoff summary** (2 lines: what changed, what's still open) that
  lands in every session's feed.
- UI phases: phase A = multiple conversations in one window taking turns (bus already supports it);
  phase B = `File > New window` (BrowserWindows share main-process state, so the ledger just works).
- **Scale target (Lachy, 2026-07-02): ~10 agents fanned out across one huge codebase in parallel.**
  Opening a side chat must never interrupt a running agent — every session run is already an
  independent main-process promise, so parallelism is natural; the bus + claim ledger is purely
  additive coordination. Fan-out flow: an orchestrating agent splits the feature into disjoint
  file-territory tasks, spawns N runs, each claims its territory, they steer each other through
  directives at stage boundaries, and a final synthesis stage merges handoff summaries.

## 4. Gallery = visual RAG for style (the differentiator)

Lachy's idea, formalized: your image gallery becomes a **style memory** the pipeline can retrieve from.

- **Ingest:** drag images in (later: Pinterest board URL — start with manual drop; Pinterest API
  approval is slow, and board RSS/exports can bridge).
- **Auto-card:** a local vision model (Ollama llava / gemma vision) captions each image into a
  structured style card: `{ caption, mood tags, era, density, extracted palette }` — palette comes
  from median-cut extraction (pure JS, no model). Cards are cheap text.
- **Retrieve:** at the frontend stage, match the plan against cards (tag/keyword first, embeddings
  later); pick the top reference.
- **Condition:** attach the card + (if the frontend model is multimodal) the image itself:
  "Replicate this reference's style: …". Non-multimodal models still get the card text + palette.
- **Attach point:** a Gallery board = a skill node in the orchestration graph, so "UI Design w/
  my-moodboard" is literally part of the pipeline.
- Chat line: `Style reference: [thumbnail] "warm editorial, cream/rust, serif display"`.
- Combines with Design Seeds: a gallery hit overrides the seed bank (your taste > canned taste).

## 5. Marketplace — GitHub-native registry (publish + install)

No backend, no accounts. Model it on Obsidian community plugins / Homebrew taps:

- **Registry = a public git repo** (`metis-registry`): one folder per package with `manifest.json`
  `{ id, kind: skill|mcp|preset|pipeline, name, version, publisher, description, tags[],
  permissions_requested[], source_url, sha256, images[] | ascii_art }`. The existing
  `RegistryPackage` type already has almost exactly these fields — it was built for this.
- **Publish:** in-app "Publish" wizard generates the folder + manifest, validates, then opens a
  pre-filled PR via `gh` (or a compare URL if gh is missing). Review = human merge. ASCII art gets
  a dedicated preview box in the wizard (monospace, theme-tinted) — cheap, charming, very Metis.
- **Install:** fetch manifest + payload from `source_url`, verify `sha256`, show
  `permissions_requested` in the existing permission ceremony, write into the app-managed packages
  dir. `metisRegistry.install` IPC already exists — point it at the real repo.
- **Search:** local index over name/tags/description; tag chips in the UI.
- **Featured feed:** a `featured.json` in the registry repo — doubles as newsletter content (§8).
- GitHub sync bonus: a user's published packages page = their profile; stars on the registry PRs =
  social proof. Zero infra.

## 6. Home tab — contribution heatmap + token telemetry

All the data already exists in `ConversationRecord.turns[].createdAt` and stored `SessionRun`s.

- **Heatmap:** GitHub-style 30-day grid (messages/day, 5 intensity buckets using the accent at
  different alphas). One `useMemo` over stored conversations.
- **Token estimates:** chars/4 heuristic per turn + per stage output. Aggregate: total tokens,
  by-model ranking ("most used model"), by-day sparkline.
- **Tokens saved via local routing:** for every run that resolved to Ollama, price its tokens at
  the cloud model the policy would otherwise have picked → "~184k tokens kept local this month
  (≈ $2.10 saved)". This number is the whole local-first pitch on one line.
- Persist a tiny daily rollup in the app store so it stays fast; compute lazily.

### 6b. Heatmap v2 (Lachy's reference image, 2026-07-02)

Approved target look: card with **Overview / Models** tabs top-left, **All / 30d / 7d** range toggle
top-right; stat cells: Sessions, Messages, Total tokens, Active days, Current streak, Longest
streak, Peak hour, Favorite model; heatmap is an UPRIGHT GitHub-style grid (7 day-rows tall,
weeks as columns, bigger squares), not a single sideways strip; footer is a rotating fun
comparison line ("You've used ~42× more tokens than The Lord of the Rings" — LOTR ≈ 576k words
≈ 750k tokens; add a few more reference works: the Bible ≈ 1M, Wikipedia's featured articles,
Harry Potter series ≈ 1.4M). Models tab: per-model token share list. Range toggle rescales
everything.

**Token accuracy:** current numbers are chars/4 estimates. Providers return REAL usage
(Anthropic/OpenAI/DeepSeek: usage.input/output_tokens; Ollama: prompt_eval_count/eval_count) —
capture it on `ProviderInvokeResult` as `usage?: { inputTokens; outputTokens; estimated: boolean }`
and prefer it in telemetry; fall back to the estimate for old runs, and label estimates in the
tooltip.

## 7. Graph View — Obsidian-grade physics (spec)

- Force-directed sim: nodes repel (Coulomb), links pull (springs), center gravity. Verlet
  integration in a rAF loop is ~80 lines; no library needed (or d3-force if preferred). Drag/shake
  a node → sim wakes and untangles; sim sleeps when energy drops (battery-friendly).
- **Sliders** (Graph settings popover): repel force, center force, link distance, link thickness.
- **Nodes:** conversations, project files, notes, skills. **Edges:** same-project, mentions/links,
  shared tags. **Node size** = degree. **Text fade threshold** on zoom-out.
- **Color groups:** rules like Obsidian (`tag:`, `path:`, free-text query → colour). Reuse the
  slate/greyscale ramp + a few muted hues.
- **Local graph:** focus mode from an open conversation, depth slider 1-3.
- **Token heat (novel):** optional mode where node brightness = token spend in that
  conversation/file — the graph doubles as a cost map, which ties into §6 and Lachy's original
  "graph view should optimise token usage" note.

## 8. "Pulse" — the newsletter/home button gets a purpose

The empty titlebar tab becomes **Pulse**: community + news, no backend.

- Source = a curated JSON feed on GitHub Pages (can live in the registry repo):
  `{ community: [...new registry packages + showcased builds], changelog: [...], news: [{title,
  url, blurb}] }`. Lachy curates by editing a file; the app fetches over HTTPS + caches for offline.
- Sections render as compact cards; community creations link into the Marketplace detail view.
- Later: "Submit your build" = PR to the feed file. Same GitHub-native trust model as §5.

## 9. Sidebar interaction rework (Lachy's exact spec, 2026-07-02)

- Remove the grey side graphic/rail on folder rows.
- Folder + conversation rows go **full width**; on hover, a small `⋯` button fades in on the right;
  clicking opens a menu: **Pin**, **Delete** (later Rename, Open folder, Export). This supersedes
  task #17's "3-dot menu".
- The project-folder chips currently sitting **above the composer** move to a `⋯` (or folder icon)
  in the **top-right of the workspace**; clicking shows a popover with the project path, context
  resources, and add/remove actions. The composer area stays clean.

## 10. Todo board upgrades

- Compact cards (title + tag chips + optional due), column counts, drag polish.
- **Send to session:** button on a card that composes a prompt from the card and opens New session.
- **Runs create todos:** a failed verification or unfinished repair offers "Add as todo" (one slim
  line in chat, not a box).
- Later: agent-managed column ("Metis is doing these") fed by the managed-agents roster (§3).

## 11. Manager (see MANAGER.md for the earlier decisions)

Permission-gated in-app assistant, ~Library-width × ⅓-height widget. New planning: it should be
**event-driven, suggestion-first** — watches the audit log + bus and surfaces chips ("3 runs failed
verification in web1 — want a repair sweep?", "You haven't keyed DeepSeek but the pipeline wants
it"). Every action is an approval chip, never autonomous. It's the same directive bus again: the
Manager posts directives like everyone else.

## 12. Routines / schedules

- A routine = `{ name, schedule (cron-lite: daily/weekly/interval), prompt, pipeline/preset,
  projectPath?, notify }`. Runs land in a dedicated conversation per routine (history = audit).
- UI: alarm-app-style list of cards — big time, name, next-run countdown, enable toggle; a visual
  hour-dial editor for pick-a-time. Design language: same slim greyscale, the dial is the one
  allowed flourish.
- Main-process scheduler: `setTimeout` chain persisted in the app store (survives restart by
  recomputing next fire on boot). Missed-while-closed policy: run-on-next-launch toggle.

## 13. Settings expansion

Sections: **Providers** (exists) · **Chat** (route-ceremony verbosity: minimal/normal/verbose,
operations detail default, streaming on/off) · **Appearance** (accent, density, font size) ·
**Privacy** (raw prompt storage — exists, move here; audit retention) · **Data** (export/import
conversations, wipe) · **Updates/About**. The Chat section is the important one — it makes the
"how much trace do I see" fight (§ the operations wall) a user setting instead of a hardcode.

## 14. Open-source distribution, updates, and live catalogs

Lachy's goal: fully open source; users install via an executable/package and stay current.

- **Packaging:** electron-builder → NSIS .exe (later winget manifest, and dmg/AppImage). CI on
  GitHub Actions builds releases from tags.
- **Auto-update:** electron-updater against GitHub Releases. When an update is available, show a
  small dot/badge next to the Pulse (newspaper) icon; clicking shows changelog + "Update now"
  (download + relaunch). No forced updates.
- **Live catalogs (the fix for "adding model names by hand is clunky"):** the registry repo hosts
  `catalog/models.json` — the canonical model list (provider, display name, API id, tier, cutoff
  notes). The app fetches it on launch (cached offline), so EVERYONE's model picker gains "Sonnet 5"
  the day it's added to the repo — no app release needed. Hand-added custom models stay as a local
  overlay on top. Same mechanism serves `catalog/providers.json` (API endpoints/defaults) and
  `featured.json` (Pulse). One PR updates the world.
- The composer "add a model" flow stays for private/local tags, but stops being the primary path.

## 15. Smart composer suggestions

The placeholder ("Describe a task or ask a question") sometimes offers the likely next step as
ghost text — Tab or click to accept, type to dismiss.

- v1 heuristic (no tokens): derive from the last run in the open conversation — verification still
  failing → "Fix the remaining console error"; build verified → "Add a second page" / "Deploy it";
  a repair gave up → "Retry the build with a different model"; user mentioned an unfinished noun
  ("migration", "refactor") → "Continue the <noun>".
- v2: after each run, ask the LOCAL model (free) for one ≤8-word next-step suggestion; store it on
  the conversation; show it next time. Never block the composer on it.

## 16. Knowledge Banks — agentic RAG (Lachy's primary Graph View goal, 2026-07-03)

Lachy's stated vision (NotebookLM / Hermes style): the Graph View is the front-end of a personal
knowledge bank. Full loop: **Ingestion** (documents, PDFs, videos, web links) → **Chunking** →
**Vectorization** (embeddings; local via Ollama `nomic-embed-text` or similar) → **Retrieval**
(semantic search over the bank on every question) → **Grounded generation** (answers cite and stick
to the retrieved chunks — hallucination reduction is the whole point). Then the Hermes step:
**agentic RAG** — the model uses function-calling to choose WHICH bank to search, reorganize the
knowledge base, and remember past interactions (self-improving).

Metis mapping: banks = project folders + attached resources + conversations; the existing
`ProjectContextSnippet` retrieval upgrades from keyword to embeddings; graph nodes = documents/
chunks/conversations; clicking a node OPENS the item (see graph amendments below) with the
directory rail on the right for quick file access. MCP-style tools let the orchestrator query banks
mid-pipeline. Build order: embeddings index over project resources → retrieval into chat/stages
with "grounded on N chunks" slim lines → ingestion UI (drop PDFs/links) → agentic bank-selection.

## 17. Feedback batch 2026-07-03 (post-gym) — queued amendments

- **Graph View:** nodes should be SLEEK DARK (greyscale like the rest of the app), not the coloured
  hue-ramp — keep colour only as a subtle accent ring/glow at most. Clicking a node OPENS the
  conversation/file (graph is a launcher, not just a viewer), keeping a right-side directory rail
  for quick file access. Later (noted, not priority): add folders into the graph manually, pin
  nodes, and search within the graph.
- **Workspace top-right 3-dot popover:** keep change-folder + the working-folder directory list;
  DROP the redundant add-files entries; ADD conversation actions: Rename, Archive, Delete. Both
  3-dot affordances should sit top-right together.
- **Artifacts panel:** Claude-artifacts-style panel is wanted (ties into the preview rail — one
  right-side surface that shows builds, documents, artifacts).
- **Run test button (titlebar/top):** redundant — remove it, or repurpose as a "check everything"
  one-click health check (providers, policy CLI, Ollama, registry reachability).
- **BUG — purple ring around the window:** after the white-ring fix, a purple outline appears
  around the window (likely another full-viewport backdrop button getting the Chromium default
  focus ring — perm/pulse/workspace popover backdrops). Fix globally: every `*-backdrop` element
  gets outline:none/appearance:none, or better, stop rendering backdrops as <button> (use a div
  with onPointerDown + Escape handling on the popover).
- **Marketplace:** collapse kinds — `preset`/`pipeline`/`template` are all just **presets** (a
  preset = a saved orchestration setup; it should list its prerequisite SKILLS inside the expanded
  card). Replace/augment the UI Design example with **github.com/lachydotmcg/slopsec** (Lachy rates
  it; he'll supply more skills). Expandable skill cards: install count, GitHub stars (fetchable from
  the API for source repos), or in-platform starring. 
- **Onboarding tutorial (pre-release):** first-run walkthrough that installs prerequisites — which
  Ollama models to pull, which skills a chosen preset needs — one guided flow.
- **Gallery vision model:** Lachy wants **gemma 4** for image review; he doesn't have it locally —
  the app (or tutorial) can `ollama pull` it with consent + progress UI. Autodetect stays as the
  fallback strategy.
- **STILL NOT BUILT (agents died on session limit 2026-07-03 afternoon):** parallel sessions phase A
  (per-conversation busy/pending-turn state, runs surviving conversation switches) and the Gallery
  visual-RAG backend (vision autodetect + median-cut style cards + frontend-stage retrieval). Both
  briefs are fully specified in the transcript/memory — re-dispatch when usage resets.

## 18. Feedback batch 2026-07-03 evening

- **Graph nodes v3:** Obsidian-style — SMALLER and LIGHT grey/white bodies on the dark canvas
  (invert the current dark fills; think #b8bcc4 body, brighter on hover). Keep the accent ring on
  select. **Delete the right directory rail** (§17 3c) — too chunky, doesn't fit; node-click-opens
  is the navigation.
- **SlopSec ascii art** — FIXED in the registry (was hand-drawn figlet misrendering "SLOPSFC";
  replaced with a clean boxed banner).
- **Installed skills → Library:** packages installed from the Marketplace must appear in the
  orchestration Library's Skills tab and be attachable to pipeline nodes like built-in skills.
  Data path: `metisRegistry.listInstalled()` (kind "skill") merged into the skills palette; the
  installed payload (skill.md) is what gets injected when the pipeline runs.
- **Custom local skills:** an "Add skill" affordance (Library tab) to register your own local
  skill file/folder directly — no registry required.
- **Run test (Orchestration view, near zoom) made REAL:** replace the visual-only pulse with an
  actual route test — send a tiny prompt through the configured graph (policy decide → selected
  node's model, per-node result chips ok/fallback/error). The titlebar "Check everything"
  stethoscope was appreciated-but-not-loved: fold its health sweep INTO this orchestration Run
  Test (one surface), remove the titlebar button.
- **Pulse → full home view:** not a popover — a proper nav view sized like Orchestration that
  walks through changelogs, community projects, and news as a scrolling feed (cards, images later).
  The titlebar newspaper button navigates there; unread dot stays.
- **Vision model:** `gemma4:e4b` is NOW PULLED locally — gallery captioning should light up via the
  existing autodetect (verify "gemma" matches the tag `gemma4:e4b`). 
- **Benchmark/tutorial north star:** the benchmark should figure out the BEST models for the
  user's hardware automatically, then a single Install button pulls everything needed (models,
  skills, prerequisites) in one click.
- **Marketplace trust + detail:** GitHub stars (API fetch for source repos) and/or in-app stars,
  install counts; clicking a package opens a github-repo-style DETAIL VIEW (readme/skill content
  rendered, stats, publisher, versions) instead of just a card.

## 19. The "Never Run Dry" router — free-tier pool + quota-aware rotation (Lachy, 2026-07-04)

Lachy's insight: beyond routing for QUALITY, route for QUOTA. Users sign up for several free
tiers (Groq, NVIDIA NIM — which serves DeepSeek models free with an API key, Gemini free tier,
OpenRouter free models) and Metis rotates across them so you effectively never run out of free
tokens.

- **Provider pool:** allow MULTIPLE keys/accounts per provider slot (`ProviderAccount { provider,
  keyRef, label, tier: "free"|"paid", cooldownUntil?, usedToday }`). Secrets storage already
  exists; extend to lists.
- **New providers:** NVIDIA NIM (`integrate.api.nvidia.com`, OpenAI-compatible chat endpoint —
  serves DeepSeek/Llama/etc. free with an NVIDIA key) and Groq (`api.groq.com`, OpenAI-compatible,
  generous free tier, very fast). Both are OpenAI-schema — reuse the existing OpenAI invoke branch
  with different base URLs.
- **Rotation policy:** on 429/quota/insufficient-balance errors, mark the account cooling
  (parse retry-after when present, else exponential), fall through to the next pooled account,
  then to the next provider in the chain — the existing `callStageWithFallback` cascade is the
  natural place. Track real usage per account (usage capture already exists) so the router can
  PREDICT exhaustion and pre-rotate.
- **UI:** Settings providers section shows the pool per provider with per-account health/quota
  bars; chat timeline notes rotations the same slim way fallbacks show today ("Groq free tier
  cooling down — rotated to NVIDIA NIM.").
- This is a headline differentiator for local-first users: quality routing + cost routing +
  quota routing in one policy.

## 21. Provider-agnostic model access — models × routes (Lachy, 2026-07-04)

Lachy's key insight refining §19: **a model and the API it's reached through are separate axes.**
DeepSeek V4 is one model reachable via DeepSeek's own API, NVIDIA NIM, or OpenRouter; the same
will be true of most open models. The user wants "near limitless flexibility": a shitload of
models in the picker, and each orchestration node configurable to reach its model through a
CHOSEN route — with key fallback across routes.

- **Catalog schema v2:** model entries gain `access: [{ provider, id }]` — every known route to
  the same model, ordered by preference. v1 entries (single provider+id) auto-upgrade to a
  one-route access list. The registry's models.json evolves without breaking v1 readers.
- **Picker UX:** pick the MODEL; the route is chosen automatically (first access route whose key
  is configured and not cooling). A small "via NVIDIA NIM" suffix shows the resolved route; a
  long-press/submenu lets power users pin a specific route.
- **Node inspector:** each orchestration node gets an optional "Access via" override (Auto /
  specific provider), stored in the graph state.
- **Route fallback before model fallback:** when invoking, walk the model's access routes
  (configured, not cooling) FIRST; only after all routes fail does the chain fall back to the
  next MODEL. Cooldowns (§19) key by provider now, by account in pool phase 2.
- **Resolution order:** node override > user route pin > first healthy configured route.
- Catalog updated 2026-07-04 with Lachy's full model zoo (Claude 5 family, GPT-5.6 Sol/Terra/Luna,
  Gemini 3.x, DeepSeek V4, Grok 4.3, GLM 5.2, Kimi K2.6, and the local fleet: Qwen3 family,
  QwQ, Llama 4 Scout/Maverick, R1 distills, Gemma 3/4, gpt-oss). Ids are best-effort — the
  registry PR flow is the correction mechanism.

## 20. Loop-transcript chat polish (Lachy, 2026-07-04)

Lachy loves Claude Code's loop UX: every action ("Searched code", "Ran 2 agents, used 2 tools",
"Read a file, edited a file") is a compact expandable chip in the transcript. Metis chat already
has slim expandable operation lines; extend the same grammar to EVERYTHING the orchestrator does:
retrieval ("Searched project — 3 snippets"), context loads, stage calls, agent fan-outs (future
managed agents render as "Ran 2 agents" summary chips expanding to per-agent detail), and
routine firings. One visual grammar: collapsed one-liner → expandable detail, never a wall.

---

## Suggested order for Opus/Sonnet sessions

1. §9 sidebar rework + §2 preview rail (visible daily-driver wins)
2. §1 design seeds (kills the slop complaint at the root) + §6 home telemetry
3. §5 marketplace registry (repo first, then wizard) + §8 Pulse (shares the repo)
4. §4 gallery visual RAG → then §3 managed agents phase A → §7 graph physics → §12 routines
