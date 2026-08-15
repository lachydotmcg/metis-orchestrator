/** Cross-conversation memory: the rules that make it safe to put on the hot
 *  path (docs/MEMORY_AND_LINKS.md, build order step 5).
 *
 *  The retrieval machinery for this has existed since knowledge banks phase 2 —
 *  a local embeddings index over past conversations, reachable over IPC — and
 *  nothing called it. The code comment said "not wired into any prompt-assembly
 *  site yet", which reads as an oversight and was actually load-bearing. Two
 *  things make a naive wiring worse than leaving it alone, and both are fixed
 *  here rather than in the retrieval:
 *
 *  1. **The current conversation is already in the prompt.**
 *     `recentConversationContext` puts up to 3000 characters of the live thread
 *     into every chat call. A semantic search that includes that same thread
 *     retrieves text the model is already being shown, and pays embedding cost
 *     to duplicate it. The value here is the OTHER threads: "you worked this
 *     out three weeks ago" is the thing nothing else in the app can say.
 *
 *  2. **The index invalidates on every single turn.** Its signature counts each
 *     conversation's turns and last-updated time, so finishing a turn changes
 *     it — and a signature miss rebuilds the whole thing, embedding up to 200
 *     chunks through Ollama. On the hot path that is a full re-index per
 *     message. Staleness is the correct trade: memory of *past* conversations
 *     does not need the sentence typed four seconds ago, because the live
 *     thread is already injected verbatim by the function above.
 */

/** How long a signature-stale conversation index stays usable.
 *
 *  Ten minutes, and the number matters less than the shape: this exists so an
 *  ongoing chat does not re-embed the corpus every turn, and anything from
 *  "a few minutes" up would do that. A signature MATCH still wins at any age —
 *  the TTL only ever rescues a mismatch. */
export const CONVERSATION_INDEX_TTL_MS = 10 * 60 * 1000;

export interface ConversationIndexFreshness {
  /** Signature stored with the cached index, or null when there is no cache. */
  cachedSignature: string | null;
  currentSignature: string;
  /** When the cache was built, epoch ms. Null for a cache written before this
   *  field existed, which must NOT be treated as infinitely fresh. */
  cachedAt: number | null;
  now: number;
  ttlMs?: number;
}

/** Whether the conversation index has to be rebuilt from scratch.
 *
 *  Three answers, and the middle one is the whole point:
 *   - signature matches → reuse, at any age. Nothing has changed.
 *   - signature differs but the cache is young → REUSE, deliberately stale.
 *   - signature differs and the cache is old (or undated) → rebuild.
 *
 *  An undated cache rebuilds rather than being trusted: a cache written before
 *  this rule existed has no age, and treating "unknown" as "fresh" would pin a
 *  stale index forever. */
export function shouldRebuildConversationIndex(input: ConversationIndexFreshness): boolean {
  if (!input.cachedSignature) return true;
  if (input.cachedSignature === input.currentSignature) return false;
  if (typeof input.cachedAt !== "number" || !Number.isFinite(input.cachedAt)) return true;
  const ttl = typeof input.ttlMs === "number" && input.ttlMs > 0 ? input.ttlMs : CONVERSATION_INDEX_TTL_MS;
  // A clock that jumped backwards would otherwise make an old cache look
  // brand new and never rebuild.
  const age = input.now - input.cachedAt;
  if (age < 0) return true;
  return age > ttl;
}

/** Drops chunks belonging to the conversation the user is currently in.
 *
 *  Not an optimisation. Those turns are already in the prompt verbatim, so
 *  retrieving them spends the reader's limited attention on text it has
 *  already been given — which is precisely the harm the per-reader retrieval
 *  policy exists to bound. */
export function excludeCurrentConversation<T extends { conversationId: string }>(
  chunks: readonly T[],
  currentConversationId?: string
): T[] {
  if (!currentConversationId) return [...(chunks ?? [])];
  return (chunks ?? []).filter((chunk) => chunk.conversationId !== currentConversationId);
}

/** The prompt block for retrieved past-conversation text.
 *
 *  Labelled as EARLIER and OTHER on purpose. The live thread arrives in the
 *  same prompt under its own heading, and a model handed two blocks of dialogue
 *  with no way to tell them apart will answer the older one — the failure is
 *  not that it ignores the context but that it responds to the wrong turn. */
export function conversationMemoryBlock(chunks: readonly { text: string }[], charCap: number): string {
  const usable = (chunks ?? []).map((chunk) => chunk.text?.trim()).filter((text): text is string => Boolean(text));
  if (!usable.length) return "";
  let body = usable.join("\n\n---\n\n");
  if (body.length > charCap) body = `${body.slice(0, charCap)}\n[truncated]`;
  return (
    "From EARLIER, SEPARATE conversations (background only — these are not the current thread and have already been answered. " +
    "Do not reply to them; use them only if they help with the newest message):\n\n" +
    `${body}\n\n`
  );
}
