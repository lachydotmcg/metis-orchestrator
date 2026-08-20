// Knowledge Banks: chunking, similarity and the context cap.
//
// The arithmetic that decides what a model is shown about your own files. Every
// bug in it is a quiet one — a chunk boundary that splits a function in half, a
// similarity floor that lets an unrelated file in, a cap that silently drops the
// most relevant chunk — and none of them announce themselves. The answer just
// comes back slightly wrong, grounded in the wrong thing.
//
// None of it was testable until the carve (docs/STRUCTURAL_DEBT.md item 1), and
// the reason is worth naming: it was not that the functions were bad, it was
// that they sat in a file importing electron. Nothing here does, so this runs
// against the real compiled module. Embedding is the one part that needs Ollama
// and it is injected, so the ranking can be exercised with vectors chosen to
// make the answer obvious.
//
// Offline: no model is called, no network is touched, no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const k = await fromBuild("electron/knowledge.js");

section("Cosine similarity, including the cases that would divide by zero");
{
  check("identical vectors are 1", Math.round(k.cosineSimilarity([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1);
  check("orthogonal vectors are 0", k.cosineSimilarity([1, 0], [0, 1]), 0);
  ok("opposite vectors are negative", k.cosineSimilarity([1, 1], [-1, -1]) < 0);
  // Magnitude must not matter — an embedding that happens to be longer is not
  // more similar, and a scaled copy is the same direction.
  check("scale does not change the answer", Math.round(k.cosineSimilarity([1, 2, 3], [2, 4, 6]) * 1000) / 1000, 1);

  // The guards. Every one of these would be NaN from the bare formula, and NaN
  // sorts unpredictably — a single one poisons a whole ranking rather than
  // sitting harmlessly at the bottom.
  check("a zero vector is 0, not NaN", k.cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  check("two zero vectors are 0", k.cosineSimilarity([0, 0], [0, 0]), 0);
  check("empty vectors are 0", k.cosineSimilarity([], []), 0);
  check("mismatched lengths are 0", k.cosineSimilarity([1, 2], [1, 2, 3]), 0);
}

section("Chunking keeps paragraphs whole where it can");
{
  const chunks = k.chunkFileText("a.md", "First para.\n\nSecond para.\n\nThird para.");
  ok("short paragraphs pack together rather than one chunk each", chunks.length < 3);
  ok("nothing is lost", chunks.map((c) => c.text).join(" ").includes("Third para."));
  ok("every chunk names its file", chunks.every((c) => c.path === "a.md"));
  // Ordinals are how a retrieved chunk is pointed back at its place in the file.
  check("ordinals start at zero and run in order", chunks.map((c) => c.ordinal), chunks.map((_, i) => i));

  check("empty content yields nothing", k.chunkFileText("empty.md", ""), []);
  check("whitespace only yields nothing", k.chunkFileText("ws.md", "\n\n   \n\n"), []);
}

section("An oversized paragraph is split rather than truncated");
{
  // The case that matters for code: a minified file, or a long function with no
  // blank lines, is one "paragraph" far past the chunk size. Dropping it would
  // make a real file invisible to retrieval.
  const oneLongLine = "x".repeat(k.KNOWLEDGE_CHUNK_SIZE * 3);
  const chunks = k.chunkFileText("big.txt", oneLongLine);
  ok("it produces chunks rather than nothing", chunks.length > 0);
  ok("and the content survives", chunks.map((c) => c.text).join("").length >= k.KNOWLEDGE_CHUNK_SIZE);

  // Many lines, each short, totalling well past the limit — the line-packing
  // fallback.
  const manyLines = Array.from({ length: 400 }, (_, i) => `line ${i} of some code`).join("\n");
  const packed = k.chunkFileText("code.ts", manyLines);
  ok("a long run of lines is split into several chunks", packed.length > 1);
  ok("each chunk stays near the size limit", packed.every((c) => c.text.length <= k.KNOWLEDGE_CHUNK_SIZE * 1.5));
  ok("the last line still appears somewhere", packed.some((c) => c.text.includes("line 399")));
}

section("The thresholds are the ones the docs describe");
{
  // Pinned because they are the whole behaviour: a floor that drifts up
  // silently returns nothing, and one that drifts down grounds answers in
  // unrelated files.
  check("chunk size", k.KNOWLEDGE_CHUNK_SIZE, 1500);
  check("top K", k.KNOWLEDGE_TOP_K, 4);
  check("similarity floor", k.KNOWLEDGE_SIMILARITY_FLOOR, 0.3);
  check("context cap", k.KNOWLEDGE_CONTEXT_CHAR_CAP, 6000);
  check("max chunks indexed", k.KNOWLEDGE_MAX_CHUNKS, 200);
  ok("the floor is a real threshold, not effectively zero", k.KNOWLEDGE_SIMILARITY_FLOOR > 0.1);
}

section("The context block is capped, and the cap cannot silently empty it");
{
  const chunk = (text) => ({ path: "f.md", ordinal: 0, text, score: 0.9 });

  const small = k.knowledgeContextBlock([chunk("alpha"), chunk("beta")]);
  ok("short chunks all appear", small.includes("alpha") && small.includes("beta"));

  // A grounding block that crowds out the prompt it is grounding is worse than
  // no grounding: the model loses the question.
  const huge = k.knowledgeContextBlock([chunk("y".repeat(20000))]);
  ok("an oversized block is capped", huge.length <= k.KNOWLEDGE_CONTEXT_CHAR_CAP + 500);
  ok("but it is not emptied", huge.length > 100);

  check("no chunks produces no block", k.knowledgeContextBlock([]), "");
}

section("Nothing here needed a model, a network or an app");
{
  // The point of the carve, asserted as a property of the module rather than as
  // a comment: it loaded, and every function above ran, with no Ollama and no
  // electron. Before 2026-08-20 none of this could execute outside the app.
  ok("the module exposes its own thresholds", typeof k.KNOWLEDGE_CHUNK_SIZE === "number");
  ok("and its pure helpers", typeof k.cosineSimilarity === "function" && typeof k.chunkFileText === "function");
  ok("and still requires wiring before anything that embeds", typeof k.configureKnowledge === "function");
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
