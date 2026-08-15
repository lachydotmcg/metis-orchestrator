// The loop walkthrough: the report an unattended run leaves behind. Imports the
// real formatter from the build.
//
// Why this file is mostly about ORDER and about REFUSALS rather than about
// prose:
//
// The walkthrough's whole claim (docs/COMPETITIVE_SWEEP.md, shortlist item 1)
// is that Metis can print a line no competitor can — which turn was judged
// trivial, which was judged deep, and what each one therefore cost. Every agent
// can list the files it wrote. So the routing trace goes FIRST, and a later
// tidy-up that moves it below the file list would quietly delete the only
// differentiated thing in the document while leaving every word intact.
//
// The refusals: an unknown price must never render as $0.00, an unpriced turn
// must never be summed in as zero, and a walkthrough must never overwrite a
// file Metis did not write. The last one matters most because a loop settles
// with nobody watching, so a clobbered document is discovered late or never.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { formatWalkthrough, walkthroughFileName, WALKTHROUGH_MARKER } = await fromBuild("shared/walkthrough.js");
const { filesFromOperations, LOOP_FILES_MAX } = await fromBuild("electron/loops.js");

const PRICING = { "anthropic::claude-opus-5": { in: 5, out: 25 } };

const RUN = {
  loopId: "loop-abc12345",
  goal: "Make the landing page load under a second",
  status: "stopped",
  stoppedReason: "the model chose to stop: the budget target is met",
  createdAt: "2026-08-15T01:00:00.000Z",
  finishedAt: "2026-08-15T02:30:00.000Z",
  projectPath: "C:/site",
  budgetTokens: 200000,
  pricing: PRICING,
  history: [
    {
      index: 1,
      at: "2026-08-15T01:00:00.000Z",
      step: "measure",
      decision: "continue",
      reason: "found three blocking scripts",
      summary: "Measured the page.",
      routing: { provider: "ollama", model: "qwen3:8b", depth: 1, inputTokens: 900, outputTokens: 300, durationMs: 4200 },
      evidence: [{ label: "npm run build", status: "complete", exitCode: 0 }]
    },
    {
      index: 2,
      at: "2026-08-15T01:40:00.000Z",
      step: "fix",
      decision: "stop",
      reason: "the budget target is met",
      summary: "Deferred the scripts.",
      routing: {
        provider: "anthropic",
        model: "claude-opus-5",
        depth: 3,
        inputTokens: 20000,
        outputTokens: 4000,
        durationMs: 31000
      },
      files: [{ path: "index.html", kind: "edit", addedLines: 4, removedLines: 2 }],
      evidence: [{ label: "npm test", status: "error", exitCode: 1, detail: "1 failing" }]
    }
  ]
};

section("The routing trace comes first, because it is the only differentiated line");
{
  const text = formatWalkthrough(RUN);
  const routing = text.indexOf("## How it was routed");
  const wrote = text.indexOf("## What it wrote");
  const checked = text.indexOf("## What it checked");
  ok("the routing section exists", routing > -1);
  ok("it precedes the file list", routing < wrote);
  ok("and precedes the evidence", routing < checked);
  // Files-then-routing is what every competitor produces. If this ever flips,
  // the document still reads fine and has lost its entire argument.
  ok("the file list is not first", wrote > routing);
}

section("Difficulty is printed as a judgement, and its absence is printed too");
{
  const text = formatWalkthrough(RUN);
  ok("a trivial turn says so", text.includes("trivial (L1)"));
  ok("a deep turn says so", text.includes("deep (L3)"));
  const noDepth = formatWalkthrough({
    ...RUN,
    history: [{ index: 1, at: RUN.createdAt, decision: "stop", routing: { provider: "ollama", model: "qwen3:8b" } }]
  });
  // A blank difficulty column reads as "the judge said nothing". Depths being
  // switched off is a different fact and has to look different.
  ok("Depths off reads as not judged, never blank", noDepth.includes("not judged"));
}

section("Money: free is free, unknown is unknown, and neither is zero");
{
  const text = formatWalkthrough(RUN);
  ok("the local turn is Free", text.includes("Free"));
  ok("the priced turn shows a dollar figure", /\$\d+\.\d\d/.test(text));

  const unpriced = formatWalkthrough({ ...RUN, pricing: {} });
  ok("a turn with no known price renders an em dash", unpriced.includes("—"));
  ok("and never a fake $0.00 in its row", !/\| \$0\.00 \|/.test(unpriced));
  // The total is the dangerous one: summing an unknown as zero produces a
  // number that looks precise and understates the bill.
  ok("the total names the turns it could not price", unpriced.includes("no price in the catalogue"));
}

section("Estimated token counts keep their tilde all the way to the total");
{
  const estimated = formatWalkthrough({
    ...RUN,
    history: [
      {
        index: 1,
        at: RUN.createdAt,
        decision: "stop",
        routing: { provider: "anthropic", model: "claude-opus-5", depth: 2, inputTokens: 1000, outputTokens: 500, estimated: true }
      }
    ]
  });
  ok("the row is marked estimated", estimated.includes("~1,000"));
  ok("so is the cost", estimated.includes("~"));
}

section("The local/paid split is stated, because it is what routing bought");
{
  const text = formatWalkthrough(RUN);
  ok("says how many turns cost nothing", text.includes("1 of those 2 turns ran on a local model"));
  const allLocal = formatWalkthrough({ ...RUN, history: [RUN.history[0]] });
  // All-local is not a split, and claiming one would be noise.
  ok("an all-local run makes no split claim", !allLocal.includes("of those"));
}

section("Helpers are named, and the total admits it does not count them");
{
  const withHelpers = formatWalkthrough({
    ...RUN,
    helpers: [
      { name: "reviewer", status: "done", task: "check the diff" },
      { name: "researcher", status: "failed", task: "find prior art" }
    ]
  });
  ok("each helper is listed", withHelpers.includes("reviewer") && withHelpers.includes("researcher"));
  ok("a failed helper says so", withHelpers.includes("researcher — failed"));
  // The dangerous reading is a total that looks complete. A helper's spend
  // lands in the budget but never in this table, so the file has to say which
  // number is which.
  ok("the understatement is stated", withHelpers.includes("understate"));
  ok("and no such claim when nothing was spawned", !formatWalkthrough(RUN).includes("understate"));
}

section("Evidence is separated from activity");
{
  const text = formatWalkthrough(RUN);
  ok("a passing check is marked PASS", text.includes("**PASS** turn 1: npm run build"));
  ok("a failing check is marked FAIL", text.includes("**FAIL** turn 2: npm test"));
  ok("its exit code survives", text.includes("(exit 1)"));
  const noEvidence = formatWalkthrough({
    ...RUN,
    history: [{ index: 1, at: RUN.createdAt, decision: "stop", files: [{ path: "a.txt", kind: "create" }] }]
  });
  // A turn that only wrote files verified nothing. Saying "no issues" here
  // would let a loop look verified because it was busy.
  ok("writing files is not verification", noEvidence.includes("only asserted"));
}

section("Every terminal status reads as itself");
{
  const blocked = formatWalkthrough({ ...RUN, status: "blocked", stoppedReason: "it needed a key" });
  // blocked exists so a loop can decline to claim an outcome; flattening it
  // into "stopped" would undo the reason it was added.
  ok("blocked says a person was needed", blocked.includes("Blocked"));
  ok("and does not read as finished", !blocked.includes("**Stopped.**"));
  ok("failed says failed", formatWalkthrough({ ...RUN, status: "failed" }).includes("**Failed.**"));
  ok("exhausted says it ran out", formatWalkthrough({ ...RUN, status: "exhausted" }).includes("Ran out of room"));
}

section("A pipe in a model name or a step does not break the table");
{
  const text = formatWalkthrough({
    ...RUN,
    history: [
      {
        index: 1,
        at: RUN.createdAt,
        step: "read | write",
        decision: "stop",
        routing: { provider: "ollama", model: "weird|name", depth: 1 }
      }
    ]
  });
  ok("the step pipe is escaped", text.includes("read \\| write"));
  ok("the model pipe is escaped", text.includes("weird\\|name"));
  // Escaping beats stripping: the reader still sees the character that was
  // actually in the model id.
  ok("nothing was silently deleted", text.includes("name"));
}

section("The file is recognisable as Metis's own");
{
  const text = formatWalkthrough(RUN);
  ok("it opens with the marker", text.startsWith(WALKTHROUGH_MARKER));
  ok("carrying the loop id", text.includes("loop=loop-abc12345"));
  ok("the goal is quoted", text.includes("Make the landing page load under a second"));
  ok("the chain is absent when there is none", !text.includes("Chain:"));
  ok("a chain loop prints its chain", formatWalkthrough({ ...RUN, chain: "a -> b" }).includes("Chain: `a -> b`"));
}

section("It never overwrites a file it did not write");
{
  check("a free name is taken", walkthroughFileName(null, "loop-abc12345"), "walkthrough.md");
  // Somebody's own walkthrough.md. An unattended loop clobbering it is
  // discovered late or never, so the ugly filename wins.
  check(
    "a foreign file is left alone",
    walkthroughFileName("# My release walkthrough\n\nStep one...", "loop-abc12345"),
    "walkthrough-metis-abc12345.md"
  );
  check(
    "its own previous report is replaced",
    walkthroughFileName(`${WALKTHROUGH_MARKER} loop=loop-abc12345 -->`, "loop-abc12345"),
    "walkthrough.md"
  );
  check(
    "another loop's report is not",
    walkthroughFileName(`${WALKTHROUGH_MARKER} loop=loop-99999999 -->`, "loop-abc12345"),
    "walkthrough-metis-abc12345.md"
  );
  // Path separators in an id must never reach a filename.
  ok("a hostile id cannot escape the folder", !walkthroughFileName("other", "../../etc/passwd").includes("/"));
}

section("filesFromOperations records writes, and only writes");
{
  const files = filesFromOperations([
    { kind: "file_create", target: "a.ts", addedLines: 10 },
    { kind: "file_edit", target: "b.ts", addedLines: 2, removedLines: 1 },
    // A command is evidence, not a write. Counting it here would put "npm
    // test" in the list of files the loop changed.
    { kind: "command", label: "npm test", exitCode: 0 },
    { kind: "browser_check", url: "http://localhost" },
    { kind: "file_edit" }
  ]);
  check("two writes", files.length, 2);
  check("a create is labelled create", files[0].kind, "create");
  check("an edit is labelled edit", files[1].kind, "edit");
  check("line churn survives", files[1].removedLines, 1);
}
{
  const many = filesFromOperations(Array.from({ length: 50 }, (_, i) => ({ kind: "file_edit", target: `f${i}.ts` })));
  check("the list is capped", many.length, LOOP_FILES_MAX);
  check("junk input is empty, never a throw", filesFromOperations(null), []);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
