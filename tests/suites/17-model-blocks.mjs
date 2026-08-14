// The registry of fenced blocks a model may emit. Imports the real thing.
//
// Four parsers grew independently and each picked its own selection and
// stripping policy. Those differences are load-bearing — metis-loop takes the
// LAST block because a model reasoning out loud may show an example first,
// metis-actions is anchored to the END and removed from the visible reply —
// but they looked accidental, because finding them meant reading two regexes
// in two files. This suite is where they stop being accidental.
//
// The refactor that introduced this was verified by the OTHER suites: 01,
// 04 and 15 already covered the parsers, and they passed unchanged. This one
// covers the registry itself, which nothing else touches.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { MODEL_BLOCK_TYPES, modelBlockType, findBlock, stripBlock } = await fromBuild("shared/model-blocks.js");

section("Every declared block type answers the questions that matter");
{
  ok("the registry is not empty", MODEL_BLOCK_TYPES.length > 0);
  const boundaries = new Set(["control", "action-cards", "img-data-url"]);
  for (const type of MODEL_BLOCK_TYPES) {
    ok(`${type.tag} declares a tag`, typeof type.tag === "string" && type.tag.length > 0);
    // The boundary is the reason this registry exists: a block type cannot be
    // added without someone deciding what it is allowed to become.
    ok(`${type.tag} declares a render boundary`, boundaries.has(type.boundary));
    ok(`${type.tag} declares a selection policy`, type.selection === "last" || type.selection === "trailing");
    ok(`${type.tag} declares whether it is stripped`, typeof type.strip === "boolean");
    ok(`${type.tag} explains itself`, typeof type.purpose === "string" && type.purpose.length > 20);
  }
  check("tags are unique", MODEL_BLOCK_TYPES.length, new Set(MODEL_BLOCK_TYPES.map((t) => t.tag)).size);
}

section("The three real block types are registered");
for (const tag of ["metis-loop", "metis-actions", "svg"]) {
  ok(`${tag} is known`, Boolean(modelBlockType(tag)));
}
check("an unregistered tag is unknown", modelBlockType("metis-nonsense"), undefined);

section("Selection: last-wins, because a model may show an example first");
{
  const text = 'Here is an example:\n```metis-loop\n{"decision":"stop"}\n```\nBut actually:\n```metis-loop\n{"decision":"continue"}\n```';
  const found = findBlock(text, "metis-loop");
  ok("a block is found", Boolean(found));
  ok("and it is the LAST one", found.payload.includes("continue"));
  ok("not the example", !found.payload.includes("stop"));
}

section("Selection: trailing means trailing, not merely present");
{
  const atEnd = 'Sure, here you go.\n```metis-actions\n[{"kind":"open_view"}]\n```';
  ok("a block at the end is found", Boolean(findBlock(atEnd, "metis-actions")));

  // The distinction that makes "trailing" different from "last": a block with
  // prose after it was not the model's final word, so it is not an action
  // proposal — it is the model talking ABOUT one.
  const withTail = 'Here is the format:\n```metis-actions\n[{"kind":"open_view"}]\n```\nThat is how it works.';
  check("a block with prose after it is not trailing", findBlock(withTail, "metis-actions"), null);
}

section("Stripping follows the declaration, not the caller");
{
  const reply = 'Done that for you.\n```metis-actions\n[{"kind":"open_view"}]\n```';
  check("a stripped type loses its block", stripBlock(reply, "metis-actions"), "Done that for you.");

  // svg is strip:false — it IS the reply, not scaffolding around it. Stripping
  // it would delete the thing the user asked for.
  const chart = 'Here is the chart:\n```svg\n<svg viewBox="0 0 1 1"><rect/></svg>\n```';
  check("a rendered type keeps its block", stripBlock(chart, "svg"), chart);
}

section("Nothing matches, nothing breaks");
check("no block present", findBlock("just some prose", "metis-loop"), null);
check("empty text", findBlock("", "metis-loop"), null);
check("non-string", findBlock(undefined, "metis-loop"), null);
check("unknown tag never matches", findBlock("```whatever\nx\n```", "whatever"), null);
check("stripping text with no block is a no-op", stripBlock("just prose", "metis-actions"), "just prose");
check("stripping an unknown tag is a no-op", stripBlock("just prose", "nope"), "just prose");

section("The span is returned so a caller never re-finds the block");
{
  // Re-finding was how the two parsers ended up with subtly different regexes
  // for the same job in the first place.
  const text = 'Before.\n```metis-actions\n[]\n```';
  const found = findBlock(text, "metis-actions");
  ok("a start offset is given", typeof found.start === "number");
  ok("an end offset is given", found.end > found.start);
  ok("the span covers the whole fence", text.slice(found.start, found.end).startsWith("```metis-actions"));
  ok("and ends at the closing fence", text.slice(found.start, found.end).trimEnd().endsWith("```"));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
