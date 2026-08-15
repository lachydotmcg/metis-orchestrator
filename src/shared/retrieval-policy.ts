/** How much retrieved context a given model should be handed.
 *
 *  The intuition this replaces is backwards. "Metis routes to local models,
 *  local models have small context, so retrieval matters MORE" — no. The
 *  problem is not that a 7B cannot FIT a knowledge base. It is that a 7B cannot
 *  USE what it retrieves, and handing it retrieved text actively makes it worse
 *  (docs/MEMORY_AND_LINKS.md):
 *
 *   - given a PERFECT oracle passage, a 7B extracted the right answer ~15% of
 *     the time on questions it did not already know;
 *   - adding retrieved context DESTROYED 42–57% of answers the model had
 *     previously got right unaided;
 *   - at ≤3B, oracle-correct and noisy context did statistically
 *     indistinguishable harm — it is the PRESENCE of retrieved text doing the
 *     damage, not its quality;
 *   - net expected accuracy from deploying RAG at 7B: −2.9 points.
 *
 *  So `knowledgeBankEnabled` defaulting to true was a net loss for exactly the
 *  reader Metis is proudest of routing to. The lever is not better retrieval,
 *  it is HOW LITTLE AND HOW CLEAN.
 *
 *  **This keys on the READER, not on the depth judgement**, which is a
 *  deliberate departure from the design note's framing. The measured effect is
 *  about a model's ability to use retrieved text, and difficulty is at best a
 *  proxy for that: a trivial question answered by a frontier model can still
 *  take rich context, and a hard question answered by an 8B still cannot. Depth
 *  matters only insofar as it already decided WHICH model serves — and Depths
 *  is off by default, so a depth-keyed policy would do nothing at all for most
 *  installs while the harm it exists to prevent applied to every one of them.
 *
 *  Pure, so the offline suite exercises the real thresholds.
 */

export type RetrievalPosture = "minimal" | "conservative" | "rich";

export interface RetrievalPlan {
  posture: RetrievalPosture;
  /** Chunks to inject. */
  topK: number;
  /** Cosine floor a chunk must clear to be injected at all. */
  similarityFloor: number;
}

/** Below this, retrieval is a net negative and only a near-exact match earns a
 *  place in the prompt. 10B is the paper's own line: it puts robust context
 *  utilization at "much greater than 10B", and 7B is already measurably
 *  underwater. */
export const RETRIEVAL_SMALL_MODEL_B = 10;

/** Above this, a local model reads like a cloud one for these purposes. Chosen
 *  at the top of what a single consumer GPU runs rather than from a
 *  measurement — the studies stop long before here, so this is a judgement
 *  call and is marked as one. */
export const RETRIEVAL_LARGE_MODEL_B = 32;

/** Cosine floor for the smallest readers. The design note's rule is "inject
 *  only on an explicit, high-confidence match"; this number is the judgement
 *  call that implements it, not a measured threshold. Deliberately far above
 *  the 0.3 general floor: at this size the question is not "is this the best
 *  chunk" but "is this so obviously the answer that it beats the model's own
 *  knowledge", and most retrievals should fail it. */
export const RETRIEVAL_MINIMAL_FLOOR = 0.55;

/** Parameter count in billions, read off an Ollama tag, or null when the tag
 *  does not say.
 *
 *  Tags are the only size signal available — Ollama's API reports a byte size
 *  that mixes quantisation in, so a 4-bit 30B and an 8-bit 13B look alike.
 *  Matches `8b`, `3.2b`, `qwen3:8b`, `gpt-oss:20b`, `llama3.2:3b-instruct-q4`. */
export function localModelParams(model: string): number | null {
  if (typeof model !== "string") return null;
  // The size marker follows a tag/word boundary and is followed by one, so a
  // "b" inside a name ("nomic-embed-text", "codegemma") cannot be read as
  // billions, and neither can the 3 in "llama3".
  //
  // Whitespace counts as a boundary specifically so the picker's display name
  // ("Qwen3 8B") reads the same as the tag ("qwen3:8b"). Oracle serves a draft
  // only on a byte-identical prompt, so if the prewarm path and the live path
  // ever disagreed about a model's size they would disagree about how many
  // chunks to inject, and every exact-match serve would quietly stop landing.
  const match = /(?:^|[\s:\-_/])(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(model);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The posture for a given serving route.
 *
 *  Cloud is `rich` unconditionally: every model Metis can reach through a paid
 *  API is far past the utilization cliff, and this is where retrieval actually
 *  pays.
 *
 *  A local model of UNKNOWN size gets `conservative` rather than either
 *  extreme. It is the middle because the failure is asymmetric and both
 *  directions are real: guessing rich on a hidden 7B reproduces the exact harm
 *  this module exists to prevent, and guessing minimal on someone's 70B
 *  silently disables a feature that was working for them. Two chunks is the
 *  answer that is never badly wrong. */
export function retrievalPostureFor(provider: string, model: string): RetrievalPosture {
  if (provider !== "ollama") return "rich";
  const params = localModelParams(model);
  if (params === null) return "conservative";
  if (params < RETRIEVAL_SMALL_MODEL_B) return "minimal";
  if (params > RETRIEVAL_LARGE_MODEL_B) return "rich";
  return "conservative";
}

/** The retrieval plan for a serving route.
 *
 *  `richTopK` and `baseFloor` are the app's existing defaults, passed in so
 *  this file owns the POLICY and main.ts keeps owning the constants — a second
 *  copy of KNOWLEDGE_TOP_K here is a number that would drift.
 *
 *  Note that `minimal` is one chunk rather than zero. Nothing measured says
 *  retrieval is worthless at 7B, only that four loose chunks are worse than
 *  none; a single chunk that cleared a high bar is the version of retrieval the
 *  evidence still supports, and zero would make the knowledge bank silently
 *  inert on the tier Metis routes to most. */
export function retrievalPlanFor(
  reader: { provider: string; model: string } | undefined,
  defaults: { richTopK: number; baseFloor: number }
): RetrievalPlan {
  // No reader known means the caller could not say who is about to read this,
  // and today's behaviour stands. A silent policy change at a call site nobody
  // updated is worse than an unimproved one.
  if (!reader) return { posture: "rich", topK: defaults.richTopK, similarityFloor: defaults.baseFloor };
  const posture = retrievalPostureFor(reader.provider, reader.model);
  if (posture === "minimal") return { posture, topK: 1, similarityFloor: Math.max(defaults.baseFloor, RETRIEVAL_MINIMAL_FLOOR) };
  if (posture === "conservative") return { posture, topK: Math.min(2, defaults.richTopK), similarityFloor: defaults.baseFloor };
  return { posture, topK: defaults.richTopK, similarityFloor: defaults.baseFloor };
}

/** One line for the grounding operation, so the reason a turn got one chunk
 *  instead of four is legible rather than mysterious. */
export function describeRetrievalPosture(plan: RetrievalPlan): string {
  if (plan.posture === "rich") return "full retrieval";
  if (plan.posture === "conservative") return "conservative retrieval for a local model";
  return "minimal retrieval — a small local model reads its own knowledge better than retrieved text";
}
