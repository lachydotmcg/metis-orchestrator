# Memory and links, for a reader that is often a small local model

Status: design, not built. Written 2026-08-14 after two research sweeps, from
Lachy's ask: *"I want this optimised like Hermes, with good memory systems. And
I want links between documents like Obsidian that actually matter in a way LLMs
read them."*

Those are one problem, and the research says the obvious answer to both is
wrong.

---

## The finding that inverts the plan

The intuition — Metis routes to local models, local models have small context, so
retrieval matters more — is **backwards**. The problem is not that a 7B cannot
*fit* a knowledge base. It is that a 7B cannot *use* what it retrieves, and
handing it retrieved text actively makes it worse.

Measured, at 7B and below:

- With a **perfect oracle passage**, a 7B extracted the right answer only **~15%**
  of the time on questions it did not already know.
- Adding retrieved context **destroyed 42–57%** of answers the model had
  previously got right unaided.
- At ≤3B, oracle-correct and noisy context caused **statistically
  indistinguishable** harm — it is the *presence* of retrieved text doing the
  damage, not its quality.
- Net expected accuracy from deploying RAG at 7B: **−2.9 points**.
- Dominant failure mode: "irrelevant generation" — the model ignoring the
  context it was given — at 61% even at 7B.

The paper's own conclusion: the bottleneck below 7B is **context utilization, not
retrieval quality**, and robust utilization needs models "much greater than 10B".

Corroborating from the second sweep: **GraphRAG is frequently worse than plain
vector search.** On single-hop factual QA plain RAG wins (F1 64.8 vs 63.0, with
knowledge-graph variants at 34–50%). On long narrative QA plain RAG wins outright
(57.1 vs 39.2 for global/community search — the flagship mode was the *worst*).
Graph methods win only on genuine multi-hop. And construction cost is 40–57×
slower to index.

**So: no memory framework, no knowledge graph, no cleverer retrieval. The lever
is how little and how clean.**

---

## What Metis has that nobody else has

Every one of those studies assumes **one reader**. Metis does not have one
reader. It has a canvas where you assign models to tasks, and **Depths**, which
already judges how hard an individual turn is and picks the rung.

That signal is currently used for one thing — which model answers. It should
govern a second thing: **how much retrieved context that model is given.**

| Reader | Retrieval posture |
|---|---|
| Local 3–8B (Hermes 8B, Qwen 8B) | Little or none. Prefer the model's own knowledge. Inject only on an explicit, high-confidence match, and prefer one tight chunk to four loose ones |
| Local 14–30B | Conservative. 2–3 chunks, one hop of link context |
| Frontier cloud | Rich. This is where retrieval pays, and where the existing top-4 defaults are already reasonable |

Nobody else can build this, because everybody else has one model behind the
curtain. It is a feature that falls out of Metis's existing architecture almost
for free, and it is the single highest-value item in this document.

It also inverts a current default worth flagging: `knowledgeBankEnabled`
defaults to **true**, and per the evidence that is a net loss when a small local
model is answering. The flag should not be a global on/off — it should be a
per-tier policy.

---

## The design

Five layers, cheapest and best-evidenced first. Layers 1–3 are worth building
regardless of anything else; 4 and 5 are optional.

### 1. Every retrievable thing gets a structured header

id, title, type, tags, dates, outgoing links **each carrying a type**, and
computed backlinks. Not decoration — this is what makes a unit retrievable
without being read.

Metis already has most of this: the Graph View computes conversation → run →
file edges today. **They are app-derived facts, not LLM-extracted guesses**,
which sidesteps precisely the task small models are worst at. Do not build an
entity extractor. Wire up the edges that already exist.

Typed edges are historically grounded — Trigg's 1983 thesis proposed 80+ link
types including "refutes" and "supports" — and every graph-RAG system that
performs well uses them. Useful types here: `supersedes`, `implements`,
`derived-from`, `refutes`, `blocks`.

### 2. A manifest that loads first, every time

id, title, type, one-line summary, link and backlink counts. For the whole
corpus.

The arithmetic is stark: naively reading 30 notes to find one is ~60,000 tokens.
Scanning frontmatter across all of them is ~1,500. A pre-built manifest gets the
whole task to ~2,500 — about 4% of naive. That fits an 8k model's *effective*
budget, which matters because effective is well below nominal.

### 3. One-hop pre-expansion, NOT agent-pull

**This is the load-bearing decision and it is counterintuitive.**

The elegant design is to give the model a `follow_link` tool and let it decide.
Do not do this as the primary mechanism. Small models measurably **"over-rely on
an initially retrieved document, even when it lacks the necessary information,
rather than attempting a new retrieval."** They do not ask. They answer badly
with what is in front of them.

Worse, 7B is roughly the *floor* for tool-calling working at all, and accuracy
degrades as the number of available tools grows — faster for smaller models.

So: when something is loaded, **automatically** include compact previews of its
direct links and backlinks. Previews, not full text — frontmatter plus a short
summary. Depth **one**, hard-capped. Ablations show value drops off fast past one
hop while false positives climb and latency grows near-exponentially.

Expose `follow_link` / `expand(hops=2)` / `get_backlinks` as tools **as well** —
they work, and ToG and GraphReader show real gains — but treat them as upside,
never as the mechanism correctness depends on.

The evidence that this bet is sound: **GraphReader, with a 4k context window,
outperformed GPT-4 with 128k** across 16k–256k inputs, by exploring a graph
instead of reading everything. That is precisely the trade Metis is making.

### 4. Curation: deterministic first, model rarely and never in the hot path

Deterministic logic alone reaches ≥95% correctness on lexical and temporal
memory operations at **64–74ms**. A narrowly-scoped model call *only at the
mutation point* lifts the harder intent-aware cases from 0% to 78–85%, at **~2.3
seconds per mutation**.

So: heuristics (recency, embedding-similarity dedup, frequency-based promotion)
for the bulk; a model call reserved for contradiction resolution and promotion to
durable memory.

**And a constraint the frameworks do not have:** Letta, mem0 and Mastra all
assume a cheap *cloud* model absorbs the bookkeeping. Metis has one local model
serving both chat and curation, competing for the same VRAM. Background curation
must be queued for genuinely idle periods — not "async" meaning parallel on the
same GPU.

### 5. Forgetting, as a first-class operation

The blind spot nobody benchmarks. One system scored 40% recall on conversational
benchmarks while failing **0 out of 385** adversarial deletion tests. LongMemEval
and LoCoMo measure recall and never measure forgetting.

If a user says forget that key, it must actually go. Build `supersede` and
`delete` paths from the start rather than treating memory as append-only.

---

## What not to build

- **Letta / MemGPT.** The best-designed of them, and the wrong shape: its cost
  story depends on running sleep-time compute on a *stronger* model than the chat
  model, which Metis does not have. Plus a Python server and bundled
  Postgres/pgvector, ~800MB baseline, inside an Electron app.
- **Zep** — hosted only. Contradicts local-first outright.
- **Graphiti / Cognee as the primary layer.** A temporal knowledge graph is worth
  exactly as much as its extraction quality, and extraction is an LLM job at
  which small models are least reliable.
- **Any "LLM curates every write" default** (mem0's and A-MEM's out-of-the-box
  mode). Two-plus model calls per write, ~2s ingestion latency per turn, on the
  same GPU as the chat.
- **GraphRAG-style corpus-wide extraction.** It exists to *manufacture* structure
  from unstructured prose. Metis's graph already exists as app state. The
  expensive half of that pipeline is solving a problem Metis does not have.
- **Summarization as the primary compaction strategy.** Raw chunking preserves
  the signal with zero model calls and matches or beats costlier alternatives.
  Compaction's known failure is structural: what gets dropped depends on the
  summariser's guess at salience, and *you cannot tell from the compacted output
  that something important is gone*. Keep raw excerpts retrievable underneath
  anything summarised.
- **Self-RAG.** Solves "does the model know when to ask" properly, by training
  reflection tokens into the model. Requires fine-tuning; wrong cost profile for
  a bring-your-own-model app.

---

## One tension the two sweeps resolve between them

The memory research says **raw chunks beat summaries** — summarising discards the
nuance you will want three sessions later. The link research says one-hop
previews should be **summaries**, not full text.

Both are right because they are answering different questions, and the
resolution is the design:

**Summaries are for deciding what to open. Raw text is for what you actually
read.** A preview exists to let the reader — or the ranker — judge relevance
cheaply. The thing finally injected should be the raw excerpt. Never let a
summary be the only surviving copy of something.

---

## Hermes specifics

- **Do not wrap Hermes in grammar-constrained decoding.** Constrained decoding
  measurably *reduces* correctness on small models — sometimes by more than
  10–15 points — while improving syntactic validity. Hermes is trained to emit
  `<tool_call>` JSON natively and, per Nous, to repair malformed objects. Prefer
  native output plus a cheap validate-and-retry loop.
- **Format:** tools declared in a system message inside `<tools>` tags, calls
  emitted as `<tool_call>{"name":…,"arguments":{…}}</tool_call>`, results
  returned in a `tool`-role message wrapped in `<tool_response>`.
- **Do not trust advertised context.** No independent long-context stress test
  of any Hermes model was found. General findings are unkind: 11 of 12 models
  tested dropped below 50% of short-context performance at 32k, with
  Llama-3.1-8B among the worst affected. Budget an "8k" model at ~4k of
  reliably-usable context for this purpose.
- **Quantization compounds it.** Long-context and structured-output tasks degrade
  faster than perplexity suggests at 4-bit; Q4_0 KV cache is specifically flagged
  as risky for both. If a local model does curation, keep it at Q5–Q6 or better.

---

## Build order

1. **Retrieval intensity by model tier.** Highest value, uniquely cheap for
   Metis, and it turns a current net-negative default into a win.
2. **Structured headers + backlinks as data**, from the Graph View edges that
   already exist.
3. **The manifest.**
4. **One-hop pre-expansion with previews.**
5. **Wire up the conversation-memory path that is already built and unreachable**
   (`metis-knowledge:searchConversations` exists and nothing calls it) — but
   behind the tier policy from step 1, not unconditionally.
6. Deterministic curation, then forgetting.

Steps 1–3 are the ones that would change how the app behaves. The rest is
refinement.

---

## Confidence and gaps

Both sweeps flagged their own inferences, which is why this document can be
specific about what is measured and what is reasoned.

**Measured:** the small-model utilization numbers, the GraphRAG benchmark
comparisons, deterministic-vs-LLM curation latency and correctness, the
constrained-decoding penalty, GraphReader's 4k-beats-128k result, the
manifest token arithmetic.

**Inferred, not measured:**

- That small local models would specifically fail at knowledge-graph entity
  extraction. It follows from the general utilization findings; nobody has
  benchmarked it directly at this scale.
- That local background curation contends for VRAM with the foreground chat in a
  way cloud-backboned studies never had to model. Architectural observation about
  Metis's deployment, not a measured result.
- That typed edge *labels* are causally responsible for graph-RAG gains, rather
  than merely being present in the systems that happen to perform well. No
  controlled ablation isolates the label.
- That a vault with authored links makes GraphRAG's structure-*inference* step
  redundant. Follows from where its cost goes; no source addresses pre-linked
  corpora directly.

**Genuine gap:** the crossover point where "retrieval is the bottleneck" becomes
"utilization is the bottleneck" sits somewhere between GPT-5-mini-class and
Llama-3.1-8B-class capability, and nothing pins it down for the 7–14B Hermes
range specifically. That range is exactly where Metis's local users live, so this
is worth measuring rather than assuming — and Metis's Benchmark surface is
arguably the right place to measure it.
