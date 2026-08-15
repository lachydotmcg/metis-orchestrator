// How much retrieved context each reader gets. Imports the real policy from
// the build.
//
// The finding this implements inverts the obvious plan (docs/MEMORY_AND_LINKS.md).
// "Local models have small context, so retrieval matters more" is backwards: the
// problem is not that a 7B cannot FIT a knowledge base, it is that a 7B cannot
// USE what it retrieves. Given a perfect oracle passage a 7B extracted the right
// answer ~15% of the time, and adding retrieved context DESTROYED 42–57% of
// answers the model had previously got right unaided. Net expected accuracy from
// deploying RAG at 7B: −2.9 points. `knowledgeBankEnabled` defaults to true, so
// the shipped default was a measured loss for the reader Metis routes to most.
//
// Two things here are load-bearing and easy to "tidy" into something worse:
//
//   1. The policy keys on the READER, never on the depth judgement. Depths is
//      OFF by default, so a depth-keyed policy would do nothing for most
//      installs while the harm applied to all of them.
//   2. An unknown-size local model gets the MIDDLE posture. Both extremes are
//      real failures: rich on a hidden 7B reproduces the harm, minimal on
//      someone's 70B silently disables a feature that was working.
//
// Offline: no provider is called, nothing is embedded, no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const {
  localModelParams,
  retrievalPostureFor,
  retrievalPlanFor,
  describeRetrievalPosture,
  RETRIEVAL_SMALL_MODEL_B,
  RETRIEVAL_LARGE_MODEL_B,
  RETRIEVAL_MINIMAL_FLOOR
} = await fromBuild("shared/retrieval-policy.js");

const DEFAULTS = { richTopK: 4, baseFloor: 0.3 };

section("Reading a size off an Ollama tag");
{
  check("a plain tag", localModelParams("qwen3:8b"), 8);
  check("a decimal size", localModelParams("llama3.2:3.5b"), 3.5);
  check("a suffixed tag", localModelParams("llama3.2:3b-instruct-q4_K_M"), 3);
  check("a hyphenated name", localModelParams("gpt-oss:20b"), 20);
  // The picker shows display names and the store holds tags. Oracle serves a
  // draft only on a byte-identical prompt, so if these two spellings disagreed
  // about size they would disagree about chunk count and every exact-match
  // serve would quietly stop landing.
  check("the picker's display name reads the same", localModelParams("Qwen3 8B"), 8);
  check("a 'b' inside a word is not billions", localModelParams("nomic-embed-text"), null);
  check("nor is one in codegemma", localModelParams("codegemma:latest"), null);
  // "llama3" must not read as 3 billion.
  check("a version number is not a size", localModelParams("llama3"), null);
  check("junk is null", localModelParams(undefined), null);
  check("so is an empty string", localModelParams(""), null);
}

section("Posture by reader");
{
  check("a small local model gets minimal", retrievalPostureFor("ollama", "qwen3:8b"), "minimal");
  check("a 3B gets minimal", retrievalPostureFor("ollama", "llama3.2:3b"), "minimal");
  check("a mid-size local model gets conservative", retrievalPostureFor("ollama", "qwen3-coder:30b"), "conservative");
  check("a large local model reads like cloud", retrievalPostureFor("ollama", "llama3.3:70b"), "rich");
  // Cloud is rich unconditionally: every model Metis reaches through a paid API
  // is far past the utilization cliff, and this is where retrieval pays.
  check("cloud is rich", retrievalPostureFor("anthropic", "claude-opus-5"), "rich");
  check("so is deepseek", retrievalPostureFor("deepseek", "deepseek-v4-pro"), "rich");
  // The middle answer for the unknown case. Never badly wrong in either
  // direction — see the header.
  check("an unsized local model gets conservative", retrievalPostureFor("ollama", "mistral"), "conservative");
  check("the thresholds are the documented ones", [RETRIEVAL_SMALL_MODEL_B, RETRIEVAL_LARGE_MODEL_B], [10, 32]);
  // 10B is the paper's own line for robust utilization, and the boundary has to
  // sit on the safe side of it.
  check("exactly at the small threshold is not small", retrievalPostureFor("ollama", "qwen:10b"), "conservative");
}

section("Plans: how little, and how clean");
{
  const small = retrievalPlanFor({ provider: "ollama", model: "qwen3:8b" }, DEFAULTS);
  // One tight chunk beats four loose ones. Not ZERO: nothing measured says
  // retrieval is worthless at 7B, only that four loose chunks are worse than
  // none, and zero would make the knowledge bank silently inert on the tier
  // Metis routes to most.
  check("one chunk", small.topK, 1);
  ok("and only a near-exact match earns it", small.similarityFloor >= RETRIEVAL_MINIMAL_FLOOR);
  ok("which is far above the general floor", small.similarityFloor > DEFAULTS.baseFloor);

  const mid = retrievalPlanFor({ provider: "ollama", model: "gpt-oss:20b" }, DEFAULTS);
  check("conservative is two chunks", mid.topK, 2);
  check("at the ordinary floor", mid.similarityFloor, DEFAULTS.baseFloor);

  const cloud = retrievalPlanFor({ provider: "anthropic", model: "claude-opus-5" }, DEFAULTS);
  check("cloud keeps today's behaviour exactly", [cloud.topK, cloud.similarityFloor], [DEFAULTS.richTopK, DEFAULTS.baseFloor]);
}

section("An unknown reader changes nothing");
{
  // A call site that could not say who is about to read this keeps today's
  // behaviour. A silent policy change at a site nobody updated is worse than an
  // unimproved one.
  const none = retrievalPlanFor(undefined, DEFAULTS);
  check("same posture", none.posture, "rich");
  check("same numbers", [none.topK, none.similarityFloor], [DEFAULTS.richTopK, DEFAULTS.baseFloor]);
}

section("A shrunken retrieval says why");
{
  // A retrieval that quietly returns one chunk instead of four is
  // indistinguishable from a knowledge bank that has broken. The posture is a
  // deliberate choice about this reader and the operation row has to say so.
  ok(
    "minimal explains itself",
    describeRetrievalPosture(retrievalPlanFor({ provider: "ollama", model: "qwen3:8b" }, DEFAULTS)).includes("own knowledge")
  );
  ok(
    "conservative names the reason",
    describeRetrievalPosture(retrievalPlanFor({ provider: "ollama", model: "mistral" }, DEFAULTS)).includes("local model")
  );
}

section("A tiny rich default is never scaled UP by the policy");
{
  // Someone who lowered KNOWLEDGE_TOP_K to 1 must not have it raised to 2 by
  // the conservative tier: the policy exists to inject less, never more.
  const tightDefaults = { richTopK: 1, baseFloor: 0.3 };
  check("conservative cannot exceed the rich default", retrievalPlanFor({ provider: "ollama", model: "mistral" }, tightDefaults).topK, 1);
  check("neither can minimal", retrievalPlanFor({ provider: "ollama", model: "qwen3:8b" }, tightDefaults).topK, 1);
  // A raised base floor wins over the minimal floor if it is already stricter.
  const strict = retrievalPlanFor({ provider: "ollama", model: "qwen3:8b" }, { richTopK: 4, baseFloor: 0.9 });
  check("the stricter floor wins", strict.similarityFloor, 0.9);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
