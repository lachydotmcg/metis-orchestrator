// Cross-conversation memory: the two rules that make it safe to put on the
// chat hot path. Imports them from the build.
//
// The retrieval for this has existed since knowledge banks phase 2 and nothing
// called it. Its code comment said "not wired into any prompt-assembly site
// yet", which reads as an oversight and was load-bearing — wiring it naively
// makes the app WORSE in two independent ways, and this suite is those two
// ways:
//
//   1. The live thread is already in every prompt verbatim, up to 3000
//      characters of it, via recentConversationContext. A semantic search that
//      includes that thread retrieves text the model is already reading, and
//      pays an embedding round-trip to duplicate it — while spending the
//      reader's limited attention, which is the exact harm the per-reader
//      retrieval policy exists to bound.
//
//   2. The index signature counts every conversation's turn count and
//      last-updated time, so FINISHING A TURN invalidates it. A signature miss
//      re-embeds up to 200 chunks through Ollama. On the hot path that is a
//      full re-index per message, which is why staleness is the correct trade
//      here and nowhere else in the app: this index is only ever asked about
//      OTHER conversations, and the live one arrives verbatim regardless.
//
// Offline: no provider is called, nothing is embedded, no API key is read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const {
  shouldRebuildConversationIndex,
  excludeCurrentConversation,
  conversationMemoryBlock,
  CONVERSATION_INDEX_TTL_MS
} = await fromBuild("shared/conversation-memory.js");

const NOW = 1_700_000_000_000;
const fresh = (over = {}) => ({
  cachedSignature: "a",
  currentSignature: "a",
  cachedAt: NOW - 1000,
  now: NOW,
  ...over
});

section("A matching signature is reused at any age");
{
  ok("just built", !shouldRebuildConversationIndex(fresh()));
  // Nothing has changed, so age is irrelevant — the TTL exists only to rescue
  // a MISMATCH, never to expire a match.
  ok("built a year ago", !shouldRebuildConversationIndex(fresh({ cachedAt: NOW - 365 * 24 * 3600 * 1000 })));
}

section("A stale signature is tolerated while the cache is young");
{
  // THE RULE THAT MAKES THIS SHIPPABLE. Every completed turn changes the
  // signature; without this, every message would re-embed the corpus.
  ok("changed a second ago", !shouldRebuildConversationIndex(fresh({ currentSignature: "b" })));
  ok("changed a minute ago", !shouldRebuildConversationIndex(fresh({ currentSignature: "b", cachedAt: NOW - 60_000 })));
  ok("but not past the TTL", shouldRebuildConversationIndex(fresh({ currentSignature: "b", cachedAt: NOW - CONVERSATION_INDEX_TTL_MS - 1 })));
  ok("the TTL is minutes, not seconds", CONVERSATION_INDEX_TTL_MS >= 60_000);
}

section("Unknowable freshness rebuilds rather than being trusted");
{
  ok("no cache at all", shouldRebuildConversationIndex(fresh({ cachedSignature: null })));
  // A cache written before builtAt existed has no age. Treating "unknown" as
  // "fresh" would pin a stale index forever.
  ok("an undated cache", shouldRebuildConversationIndex(fresh({ currentSignature: "b", cachedAt: null })));
  ok("a junk date", shouldRebuildConversationIndex(fresh({ currentSignature: "b", cachedAt: Number.NaN })));
  // A clock that jumped backwards would otherwise make an old cache look
  // brand new and never rebuild again.
  ok("a cache from the future", shouldRebuildConversationIndex(fresh({ currentSignature: "b", cachedAt: NOW + 60_000 })));
}

section("The live thread is never retrieved back into its own prompt");
{
  const chunks = [
    { conversationId: "here", text: "the current thread" },
    { conversationId: "elsewhere", text: "an older thread" },
    { conversationId: "here", text: "the current thread again" }
  ];
  const kept = excludeCurrentConversation(chunks, "here");
  check("only other conversations survive", kept.map((chunk) => chunk.text), ["an older thread"]);
  // With no active conversation there is nothing to exclude — a fresh session
  // can still be reminded of everything.
  check("no active thread excludes nothing", excludeCurrentConversation(chunks, undefined).length, 3);
  check("junk input is empty, never a throw", excludeCurrentConversation(null, "here"), []);
}

section("The block says these are OTHER conversations, and already answered");
{
  const block = conversationMemoryBlock([{ text: "we chose Postgres" }, { text: "because of the JSON columns" }], 6000);
  // The live thread arrives in the same prompt under its own heading. A model
  // handed two blocks of dialogue with no way to tell them apart answers the
  // older one — the failure is not that it ignores the context, it is that it
  // replies to the wrong turn.
  ok("it is marked as earlier and separate", /EARLIER, SEPARATE conversations/.test(block));
  ok("and as not-the-current-thread", /not the current thread/.test(block));
  ok("and explicitly not to be replied to", /Do not reply to them/.test(block));
  ok("both chunks are present", block.includes("Postgres") && block.includes("JSON columns"));
  // Nothing to say means nothing prepended — a caller must not be able to put
  // an empty heading in front of a prompt.
  check("no chunks is an empty string", conversationMemoryBlock([], 6000), "");
  check("blank chunks are not chunks", conversationMemoryBlock([{ text: "   " }], 6000), "");
  check("junk is empty too", conversationMemoryBlock(null, 6000), "");
}

section("The block obeys its character cap");
{
  const long = conversationMemoryBlock([{ text: "x".repeat(9000) }], 500);
  ok("it is cut to the cap", long.length < 900);
  ok("and says it was cut", long.includes("[truncated]"));
}

section("Both prompt paths get the block, in the same place");
{
  // Oracle serves a pre-drafted answer only on a BYTE-IDENTICAL prompt hash.
  // A block prepended on the live path and not on the prewarm path does not
  // error — it silently stops every exact-match serve, and the feature just
  // quietly stops working. Same failure if the two prepend in different
  // orders, because the same bytes in a different order are a different hash.
  const main = readFileSync(join(process.cwd(), "src", "electron", "main.ts"), "utf8");
  const calls = [...main.matchAll(/conversationMemoryForPrompt\(/g)].length;
  // One definition plus both call sites.
  check("exactly two call sites", calls - 1, 2);
  ok("the live chat path prepends it", /sessionPrompt = `\$\{chatMemory\}\$\{sessionPrompt\}`/.test(main));
  ok("the prewarm path prepends it the same way", /memory \? `\$\{memory\}\$\{assembled\}` : assembled/.test(main));
  // Both skip on the fast lane, or a two-word turn pays for an embedding
  // round-trip on one path and not the other — which is also a hash mismatch.
  const fastLaneGuards = [...main.matchAll(/fastLane \? null : await conversationMemoryForPrompt\(/g)].length;
  check("both skip the fast lane", fastLaneGuards, 2);
  // And it is gated by the same policy as file retrieval rather than being a
  // second unconditional injection — the whole reason the design note said to
  // wire this behind the tier policy.
  ok("it is sized by the reader policy", /conversationMemoryForPrompt[\s\S]{0,900}retrievalPlanFor\(reader,/.test(main));
  ok("and respects the knowledge-bank switch", /conversationMemoryForPrompt[\s\S]{0,400}knowledgeBankEnabled/.test(main));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
