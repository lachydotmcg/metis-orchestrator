/** Knowledge Banks: local embeddings over your files and your past
 *  conversations, lifted out of main.ts.
 *
 *  Sixth carve of docs/STRUCTURAL_DEBT.md item 1 — 480 lines for **five**
 *  injected dependencies. Chosen over the Oracle block, which is bigger (647
 *  lines) and needs 23; measured rather than guessed, and the ratio decided it.
 *
 *  Two indexes with the same shape and different sources: one over the files in
 *  a project folder, one over the turns of past conversations. Both cache to
 *  disk under a signature, both retrieve by cosine similarity against a floor,
 *  and both cap what they hand back so a grounding block cannot crowd out the
 *  prompt it is supposed to be grounding.
 *
 *  Nothing here imports electron, so `35-knowledge-retrieval` can exercise the
 *  arithmetic — chunk boundaries, similarity ranking, the context cap — without
 *  a model, a network or an app. Embedding is the one part that needs Ollama,
 *  and it is injected.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { dataPath, readStoreValue } from "./store.js";
import {
  RETRIEVAL_OVERRIDE_DEFAULT,
  describeRetrievalPosture,
  retrievalPlanFor,
  type RetrievalOverride,
  type RetrievalPlan
} from "../shared/retrieval-policy.js";
import { conversationMemoryBlock, excludeCurrentConversation, shouldRebuildConversationIndex } from "../shared/conversation-memory.js";
import type { AgentOperation, ConversationRecord } from "../shared/runtime-contracts.js";

/** The three. Everything else this subsystem needs, it owns. */
export interface KnowledgeDeps {
  sha256: (value: string) => string;
  readConversations: () => Promise<ConversationRecord[]>;
  readExistingProjectFiles: (root: string) => Promise<Array<{ path: string; content: string }>>;
}

/** Where Ollama listens. Declared here as well as in main.ts rather than
 *  injected: it is a constant, and a constant behind a function call reads as
 *  though it could vary. */
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** The shape the file index is built from. Structurally identical to main.ts's,
 *  which TypeScript matches by shape rather than name. */
type GeneratedFile = { path: string; content: string };

let injected: KnowledgeDeps | null = null;

/** Wire the knowledge subsystem. Called once from main.ts. */
export function configureKnowledge(deps: KnowledgeDeps): void {
  injected = deps;
}

function need(): KnowledgeDeps {
  if (!injected) throw new Error("Knowledge Banks were used before configureKnowledge() ran.");
  return injected;
}

// --- Knowledge Banks phase 1: local embeddings retrieval (docs/FABLE_PLANS.md
// §16). STRICTLY ADDITIVE and a no-op whenever Ollama/the embed model/the
// project files/the retrieval result are unavailable — every function here
// fails soft (returns null/[] on any error) so a broken embed can never break
// a run. Uses the same OLLAMA_BASE_URL as the rest of the app (see the Ollama
// vision-RAG section below); this section is defined earlier in the file so
// it's usable by the edit/chat prompt-assembly sites above, which run later
// at runtime regardless of source order.
export const KNOWLEDGE_EMBED_MODEL = "nomic-embed-text";
export const KNOWLEDGE_MAX_CHUNKS = 200;
export const KNOWLEDGE_CHUNK_SIZE = 1500;
export const KNOWLEDGE_TOP_K = 4;
export const KNOWLEDGE_SIMILARITY_FLOOR = 0.3;
export const KNOWLEDGE_CONTEXT_CHAR_CAP = 6000;

export type KnowledgeChunk = { path: string; ordinal: number; text: string };
export type KnowledgeIndexedChunk = KnowledgeChunk & { vector: number[] };
export type KnowledgeIndex = { signature: string; model: string; chunks: KnowledgeIndexedChunk[] };
export type RetrievedKnowledgeChunk = { path: string; ordinal: number; text: string; score: number };

/** Embeds a batch of texts via Ollama's /api/embeddings, one request per text
 *  (simplest, works with any Ollama version). Returns null on ANY failure —
 *  unreachable server, missing model, malformed response — so callers can
 *  treat embeddings as simply "unavailable" and no-op. */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const vectors: number[][] = [];
    for (const text of texts) {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: KNOWLEDGE_EMBED_MODEL, prompt: text })
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { embedding?: number[] };
      if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) return null;
      vectors.push(payload.embedding);
    }
    return vectors;
  } catch {
    return null;
  }
}

/** Splits a file's text into ~KNOWLEDGE_CHUNK_SIZE-char chunks on paragraph
 *  (blank-line) boundaries where possible, falling back to line boundaries,
 *  so chunks stay deterministic and readable. */
export function chunkFileText(path: string, content: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const paragraphs = content.split(/\n{2,}/);
  let buffer = "";
  let ordinal = 0;
  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) {
      chunks.push({ path, ordinal, text: trimmed });
      ordinal += 1;
    }
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > KNOWLEDGE_CHUNK_SIZE) {
      // A single oversized paragraph — fall back to line-by-line packing.
      flush();
      const lines = paragraph.split("\n");
      let lineBuffer = "";
      for (const line of lines) {
        if (lineBuffer.length + line.length + 1 > KNOWLEDGE_CHUNK_SIZE) {
          if (lineBuffer.trim().length > 0) {
            chunks.push({ path, ordinal, text: lineBuffer.trim() });
            ordinal += 1;
          }
          lineBuffer = "";
        }
        lineBuffer += `${line}\n`;
      }
      if (lineBuffer.trim().length > 0) {
        chunks.push({ path, ordinal, text: lineBuffer.trim() });
        ordinal += 1;
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > KNOWLEDGE_CHUNK_SIZE) flush();
    buffer += `${paragraph}\n\n`;
  }
  flush();
  return chunks;
}

/** Cheap, order-independent signature over the project's source files (path +
 *  size + mtime), used to decide whether a cached knowledge index is still
 *  fresh without re-reading file contents. */
async function knowledgeSourceSignature(root: string, files: GeneratedFile[]): Promise<string> {
  const resolvedRoot = resolve(root);
  const parts: string[] = [];
  for (const file of files) {
    try {
      const info = await stat(join(resolvedRoot, file.path));
      parts.push(`${file.path}:${info.size}:${info.mtimeMs}`);
    } catch {
      parts.push(`${file.path}:${file.content.length}`);
    }
  }
  return need().sha256(parts.sort().join("|"));
}

function knowledgeCachePath(root: string): string {
  return dataPath("knowledge", `${need().sha256(resolve(root))}.json`);
}

/** Builds (or reuses a cached) local embeddings index over the selected
 *  project's files. Returns null whenever there is nothing to index or
 *  embedding is unavailable — callers must treat null as "no knowledge bank"
 *  and change nothing about the run. Never throws. */
export async function buildOrLoadKnowledgeIndex(root: string): Promise<KnowledgeIndex | null> {
  try {
    const files = await need().readExistingProjectFiles(root);
    if (files.length === 0) return null;
    const signature = await knowledgeSourceSignature(root, files);
    const cachePath = knowledgeCachePath(root);
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as KnowledgeIndex;
      if (cached.signature === signature && cached.model === KNOWLEDGE_EMBED_MODEL && Array.isArray(cached.chunks)) {
        return cached;
      }
    } catch {
      /* no usable cache — fall through to (re)build */
    }
    const allChunks: KnowledgeChunk[] = [];
    for (const file of files) {
      for (const chunk of chunkFileText(file.path, file.content)) {
        if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
        allChunks.push(chunk);
      }
      if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
    }
    if (allChunks.length === 0) return null;
    const vectors = await embedTexts(allChunks.map((chunk) => chunk.text));
    if (!vectors || vectors.length !== allChunks.length) return null;
    const index: KnowledgeIndex = {
      signature,
      model: KNOWLEDGE_EMBED_MODEL,
      chunks: allChunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))
    };
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(index), "utf8");
    } catch {
      /* cache write failure is non-fatal — the index is still usable this run */
    }
    return index;
  } catch {
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Retrieves the top-K most relevant chunks from the project's knowledge
 *  index for `query`. Returns [] on ANY failure or when the index/embedding
 *  is unavailable, or when nothing clears the similarity floor — [] is the
 *  required no-op signal for callers (no prompt change, no operation line). */
export async function retrieveKnowledge(
  root: string,
  query: string,
  topK: number = KNOWLEDGE_TOP_K,
  similarityFloor: number = KNOWLEDGE_SIMILARITY_FLOOR
): Promise<RetrievedKnowledgeChunk[]> {
  try {
    const index = await buildOrLoadKnowledgeIndex(root);
    if (!index || index.chunks.length === 0) return [];
    const queryVectors = await embedTexts([query]);
    if (!queryVectors || queryVectors.length === 0) return [];
    const queryVector = queryVectors[0];
    const scored = index.chunks
      .map((chunk) => ({ path: chunk.path, ordinal: chunk.ordinal, text: chunk.text, score: cosineSimilarity(queryVector, chunk.vector) }))
      .filter((chunk) => chunk.score >= similarityFloor)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch {
    return [];
  }
}

/** Formats retrieved chunks into a labelled context block for prompt
 *  prepending, capped to KNOWLEDGE_CONTEXT_CHAR_CAP total characters. Returns
 *  "" when given no chunks (callers should also just skip in that case). */
export function knowledgeContextBlock(chunks: RetrievedKnowledgeChunk[]): string {
  if (chunks.length === 0) return "";
  let body = chunks.map((chunk) => `# ${chunk.path}\n${chunk.text}`).join("\n\n");
  if (body.length > KNOWLEDGE_CONTEXT_CHAR_CAP) body = `${body.slice(0, KNOWLEDGE_CONTEXT_CHAR_CAP)}\n/* [truncated] */`;
  return `Relevant project context (retrieved from the knowledge bank — cite/stay grounded in this, do not contradict it):\n\n${body}\n\n`;
}

/** Builds the "Grounded on N chunks" AgentOperation for a successful
 *  retrieval. Callers only build/emit this when chunks.length > 0 — an empty
 *  retrieval must never produce an operation line. */
export function knowledgeGroundingOperation(root: string, chunks: RetrievedKnowledgeChunk[], plan?: RetrievalPlan): AgentOperation {
  const distinctFiles = Array.from(new Set(chunks.map((chunk) => chunk.path)));
  // Why this turn got one chunk instead of four, said out loud. A retrieval
  // that quietly shrinks is indistinguishable from a knowledge bank that has
  // stopped working, and the whole point of the policy is that it is a
  // deliberate choice about this reader rather than a failure.
  const postureNote = plan && plan.posture !== "rich" ? ` · ${describeRetrievalPosture(plan)}` : "";
  return {
    id: randomUUID(),
    kind: "context_load",
    label: `Grounded on ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`,
    target: root,
    status: "complete",
    charCount: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    permission: "filesystem.read",
    detail: `${distinctFiles.join(", ").slice(0, 400)}${postureNote}`,
    // Provenance (docs/DRILL_PLAN.md I9.7): one entry PER CHUNK - file, chunk
    // ordinal, and a one-line preview - so the expandable op row answers
    // "grounded on WHAT exactly", not just how many. Trust feature: the user
    // can spot a wrong/stale chunk steering an answer.
    sourcePaths: chunks.map((chunk) => `${chunk.path} #${chunk.ordinal + 1} — ${chunk.text.replace(/\s+/g, " ").slice(0, 90)}`)
  };
}

/** Single entry point for the prompt-assembly sites: retrieves knowledge for
 *  `query` against the project at `root` (honouring the knowledgeBankEnabled
 *  store toggle), and returns both the context block to prepend and the
 *  operation to emit — or null when there is nothing to ground on (the
 *  required no-op path: unchanged prompt, no operation, no timeline line). */
export async function retrieveKnowledgeForPrompt(
  root: string | undefined,
  query: string,
  reader?: { provider: string; model: string }
): Promise<{ block: string; operation: AgentOperation } | null> {
  if (!root) return null;
  try {
    const knowledgeEnabled = await readStoreValue<boolean>("knowledgeBankEnabled", true);
    if (!knowledgeEnabled) return null;
    // How much this particular reader should be handed
    // (shared/retrieval-policy.ts). The flag was a global on/off, and at 7B
    // "on" is measurably worse than "off" — so the honest control is not a
    // switch but an amount, chosen from who is about to read it.
    //
    // The override is read here rather than passed in, so both prompt-assembly
    // paths and the Oracle prewarm see the same value on the same turn. Oracle
    // serves a draft only on a byte-identical prompt hash, and a setting read
    // on one path and not the other would silently stop every exact match.
    const override = await readStoreValue<RetrievalOverride>("retrievalPosture", RETRIEVAL_OVERRIDE_DEFAULT);
    const plan = retrievalPlanFor(reader, { richTopK: KNOWLEDGE_TOP_K, baseFloor: KNOWLEDGE_SIMILARITY_FLOOR }, override);
    const chunks = await retrieveKnowledge(root, query, plan.topK, plan.similarityFloor);
    if (chunks.length === 0) return null;
    const block = knowledgeContextBlock(chunks);
    if (!block) return null;
    return { block, operation: knowledgeGroundingOperation(root, chunks, plan) };
  } catch {
    return null;
  }
}

// --- Knowledge Banks phase 2: local embeddings retrieval over past
// conversations (docs/DRILL_PLAN.md Phase 6 §16 phase 2), mirroring the
// phase 1 file-retrieval code path directly above. STRICTLY ADDITIVE and a
// no-op whenever Ollama/the embed model/conversations/the retrieval result
// are unavailable — every function here fails soft (returns null/[] on any
// error) so a broken embed can never break a run. Not wired into any
// prompt-assembly site yet — only reachable via the
// metis-knowledge:searchConversations IPC handle, for a renderer follow-up
// (retrieve-into-chat UI, per-bank surfacing) to build on.
export type RetrievedConversationChunk = { conversationId: string; ordinal: number; text: string; score: number };

/** Splits a conversation's turns into KnowledgeChunk-shaped items. Chunks on
 *  message boundaries first (each turn is its own logical unit), then
 *  sub-chunks any single turn whose content exceeds KNOWLEDGE_CHUNK_SIZE
 *  using chunkFileText's paragraph/line packer. Empty turns are skipped. */
export function conversationToChunks(conversation: ConversationRecord): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let ordinal = 0;
  for (const turn of conversation.turns) {
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    const text = turn.content.trim();
    if (text.length === 0) continue;
    if (text.length <= KNOWLEDGE_CHUNK_SIZE) {
      chunks.push({ path: `conversation:${conversation.id}#${ordinal}`, ordinal, text });
      ordinal += 1;
      continue;
    }
    for (const sub of chunkFileText(`conversation:${conversation.id}`, text)) {
      chunks.push({ path: `conversation:${conversation.id}#${ordinal}`, ordinal, text: sub.text });
      ordinal += 1;
    }
  }
  return chunks;
}

/** Cheap, order-independent signature over the stored conversation set (id +
 *  message count + last-updated per conversation), used to decide whether a
 *  cached conversation index is still fresh without re-embedding everything.
 *  Mirrors knowledgeSourceSignature above. */
function conversationIndexSignature(conversations: ConversationRecord[]): string {
  const parts = conversations.map((conversation) => `${conversation.id}:${conversation.turns.length}:${conversation.updatedAt}`);
  return need().sha256(parts.sort().join("|"));
}

function conversationIndexCachePath(): string {
  return dataPath("knowledge", "conversations.json");
}

/** Builds (or reuses a cached) local embeddings index over stored
 *  conversations. Returns null whenever there is nothing to index or
 *  embedding is unavailable — callers must treat null as "no knowledge bank"
 *  and change nothing about the run. Never throws. Mirrors
 *  buildOrLoadKnowledgeIndex above exactly, at a distinct cache path so the
 *  two indexes never collide. */
export async function buildOrLoadConversationIndex(): Promise<KnowledgeIndex | null> {
  try {
    const conversations = await need().readConversations();
    if (conversations.length === 0) return null;
    const signature = conversationIndexSignature(conversations);
    const cachePath = conversationIndexCachePath();
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as KnowledgeIndex & { builtAt?: number };
      const usable = cached.model === KNOWLEDGE_EMBED_MODEL && Array.isArray(cached.chunks);
      // A signature MISS is tolerated while the cache is young
      // (shared/conversation-memory.ts). The signature counts every
      // conversation's turns and last-updated time, so finishing a turn
      // invalidates it — and this index is now read on the chat hot path, where
      // a miss means re-embedding up to 200 chunks through Ollama per message.
      // Staleness is the right trade because the LIVE thread is already in the
      // prompt verbatim via recentConversationContext; this index is only ever
      // asked about other conversations.
      if (
        usable &&
        !shouldRebuildConversationIndex({
          cachedSignature: cached.signature ?? null,
          currentSignature: signature,
          cachedAt: typeof cached.builtAt === "number" ? cached.builtAt : null,
          now: Date.now()
        })
      ) {
        return cached;
      }
    } catch {
      /* no usable cache — fall through to (re)build */
    }
    const allChunks: KnowledgeChunk[] = [];
    for (const conversation of conversations) {
      for (const chunk of conversationToChunks(conversation)) {
        if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
        allChunks.push(chunk);
      }
      if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
    }
    if (allChunks.length === 0) return null;
    const vectors = await embedTexts(allChunks.map((chunk) => chunk.text));
    if (!vectors || vectors.length !== allChunks.length) return null;
    const index: KnowledgeIndex = {
      signature,
      model: KNOWLEDGE_EMBED_MODEL,
      chunks: allChunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))
    };
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      // builtAt is what the staleness rule reads. A cache without one is
      // rebuilt rather than trusted — "unknown age" must not mean "fresh
      // forever".
      await writeFile(cachePath, JSON.stringify({ ...index, builtAt: Date.now() }), "utf8");
    } catch {
      /* cache write failure is non-fatal — the index is still usable this run */
    }
    return index;
  } catch {
    return null;
  }
}

/** Retrieves the top-K most relevant chunks from the conversation knowledge
 *  index for `query`, building/loading the index lazily on first call (never
 *  auto-built at startup). Returns [] on ANY failure or when the
 *  index/embedding is unavailable, or when nothing clears the similarity
 *  floor — mirrors retrieveKnowledge above exactly. */
export async function retrieveConversationContext(
  query: string,
  topK: number = KNOWLEDGE_TOP_K,
  similarityFloor: number = KNOWLEDGE_SIMILARITY_FLOOR,
  excludeConversationId?: string
): Promise<RetrievedConversationChunk[]> {
  try {
    const index = await buildOrLoadConversationIndex();
    if (!index || index.chunks.length === 0) return [];
    const queryVectors = await embedTexts([query]);
    if (!queryVectors || queryVectors.length === 0) return [];
    const queryVector = queryVectors[0];
    const scored = index.chunks
      .map((chunk) => ({
        conversationId: chunk.path.replace(/^conversation:/, "").split("#")[0],
        ordinal: chunk.ordinal,
        text: chunk.text,
        score: cosineSimilarity(queryVector, chunk.vector)
      }))
      .filter((chunk) => chunk.score >= similarityFloor)
      .sort((a, b) => b.score - a.score);
    // The live thread is already in the prompt verbatim
    // (recentConversationContext), so retrieving it back spends the reader's
    // limited attention on text it has already been given.
    return excludeCurrentConversation(scored, excludeConversationId).slice(0, topK);
  } catch {
    return [];
  }
}

/** Cross-conversation memory for a prompt-assembly site
 *  (docs/MEMORY_AND_LINKS.md build order step 5).
 *
 *  Sized by the SAME per-reader policy as file retrieval, and for the same
 *  measured reason: at 7B, injected context destroyed 42–57% of answers the
 *  model had previously got right unaided. A second unconditional injection on
 *  top of the first would double exactly the harm that policy exists to bound —
 *  which is why the design note said to wire this "behind the tier policy, not
 *  unconditionally".
 *
 *  Returns null rather than an empty string when there is nothing to add, so a
 *  caller cannot accidentally prepend a blank block. */
export async function conversationMemoryForPrompt(
  query: string,
  conversationId: string | undefined,
  reader?: { provider: string; model: string }
): Promise<string | null> {
  try {
    if (!(await readStoreValue<boolean>("knowledgeBankEnabled", true))) return null;
    const override = await readStoreValue<RetrievalOverride>("retrievalPosture", RETRIEVAL_OVERRIDE_DEFAULT);
    const plan = retrievalPlanFor(reader, { richTopK: KNOWLEDGE_TOP_K, baseFloor: KNOWLEDGE_SIMILARITY_FLOOR }, override);
    const chunks = await retrieveConversationContext(query, plan.topK, plan.similarityFloor, conversationId);
    return conversationMemoryBlock(chunks, KNOWLEDGE_CONTEXT_CHAR_CAP) || null;
  } catch {
    return null;
  }
}

// Gate for the full multi-stage build pipeline. Router judgement
// (decision.task_type) is now the SOLE signal for the non-forced path — no
// more regex-sniffing the prompt for imperative build verbs. That keyword
// heuristic was too eager/too narrow in equal measure; the router's task_type
// classification (coding/frontend_design) is trusted directly, gated only by
// the opt-out/question guards below. A status question like "Without
// generating anything, what's the status of my website file?" is still kept
// out by isBuildOptOut/isBuildQuestionGuard, not by keyword-sniffing.
