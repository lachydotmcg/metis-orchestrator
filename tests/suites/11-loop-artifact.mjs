// The artifact channel between chain steps, and the helper digest's scoping.
// Imports the REAL functions from the build.
//
// The bug these exist to prevent: a parallel step group launched each member
// with the bare step string as its entire prompt, so
// `--steps "draft -> review & review & review"` started three helpers whose
// whole instruction was the word "review". They never saw the draft. Nothing
// carried work between chain positions at all, and the only thing that came
// close — summariseTurn's history digest — replaces every fenced code block
// with the literal string "(code)".
//
// The second bug: the wake prompt rendered spawnedAgents.slice(-6), a
// loop-lifetime window with no group marker, so on the second pass through a
// chain a step could not tell this cycle's reviewers from the last cycle's.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { captureArtifact, latestArtifact, helpersForWakePrompt, summariseTurn, composeWakePrompt, LOOP_ARTIFACT_LIMIT } =
  await fromBuild("electron/loops.js");

const CODE_REPLY = 'Here is the draft.\n\n```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n\nLet me know.';

section("captureArtifact keeps what summariseTurn throws away");
ok("summariseTurn really does elide the code (the bug)", summariseTurn(CODE_REPLY).includes("(code)"));
ok("the artifact keeps the fence", captureArtifact(CODE_REPLY).includes("```js"));
ok("the artifact keeps the body", captureArtifact(CODE_REPLY).includes("return a + b;"));
ok("the artifact never says (code)", !captureArtifact(CODE_REPLY).includes("(code)"));

section("The protocol block is Metis talking to itself, so it is stripped");
{
  const withBlock = 'Done the thing.\n\n```metis-loop\n{"decision":"continue"}\n```';
  ok("no protocol block survives", !captureArtifact(withBlock).includes("metis-loop"));
  ok("no decision leaks to the next step", !captureArtifact(withBlock).includes("continue"));
  check("the prose survives", captureArtifact(withBlock), "Done the thing.");
}

section("Empty and missing input");
check("empty string", captureArtifact(""), "");
check("undefined", captureArtifact(undefined), "");
check("whitespace only", captureArtifact("   \n\n  "), "");
// summariseTurn says "(no reply text)" because it is rendered into a prompt as
// a list item. An artifact is concatenated, so it must be genuinely empty or
// the caller cannot test it for absence.
check("a summary placeholder is not an artifact placeholder", summariseTurn(""), "(no reply text)");

section("Truncation keeps the tail, where a draft is usually weakest");
{
  const long = `START-MARKER\n${"x".repeat(LOOP_ARTIFACT_LIMIT * 2)}\nEND-MARKER`;
  const cut = captureArtifact(long);
  ok("the opening survives", cut.includes("START-MARKER"));
  ok("the ending survives", cut.includes("END-MARKER"));
  ok("it says it trimmed", cut.includes("trimmed"));
  ok("it is bounded", cut.length < long.length);
}
{
  const exact = "y".repeat(LOOP_ARTIFACT_LIMIT);
  check("exactly at the limit is untouched", captureArtifact(exact).length, LOOP_ARTIFACT_LIMIT);
  ok("at the limit nothing is inserted", !captureArtifact(exact).includes("trimmed"));
}

section("latestArtifact walks back past turns that produced nothing");
const turn = (index, artifact, error) => ({ index, at: `2026-07-25T00:0${index}:00Z`, summary: "s", decision: "continue", artifact, error });
check("no history", latestArtifact({ history: [] }), "");
check("newest wins", latestArtifact({ history: [turn(1, "old"), turn(2, "new")] }), "new");
check("skips a failed turn", latestArtifact({ history: [turn(1, "good"), turn(2, undefined, "boom")] }), "good");
check("skips an empty artifact", latestArtifact({ history: [turn(1, "good"), turn(2, "")] }), "good");
check("nothing anywhere", latestArtifact({ history: [turn(1, undefined), turn(2, undefined)] }), "");

section("helpersForWakePrompt: a cycle's group is never mixed with the last one's");
const helper = (name, groupStartedAt, summary = "did it") => ({ name, task: name, startedAt: `${groupStartedAt ?? "2026-01-01T00:00:00Z"}-${name}`, status: "done", summary, groupStartedAt });
{
  const cycle1 = "2026-07-25T01:00:00Z";
  const cycle2 = "2026-07-25T02:00:00Z";
  const agents = [
    helper("review 1", cycle1), helper("review 2", cycle1), helper("review 3", cycle1),
    helper("review 1", cycle2), helper("review 2", cycle2), helper("review 3", cycle2)
  ];
  const shown = helpersForWakePrompt(agents);
  check("only the newest cycle is shown", shown.length, 3);
  ok("and it is cycle 2", shown.every((a) => a.groupStartedAt === cycle2));
  // The old slice(-6) would have returned all six with nothing to tell them
  // apart. That is the bug.
  check("the flat tail would have shown six", agents.slice(-6).length, 6);
}
{
  // A group larger than the window must not lose a member: a synthesise step
  // that silently drops a reviewer is worse than one that shows none.
  const big = "2026-07-25T03:00:00Z";
  const agents = Array.from({ length: 8 }, (_, i) => helper(`review ${i + 1}`, big));
  check("no group member is dropped by the window", helpersForWakePrompt(agents).length, 8);
}

section("Helpers a decision block asked for still appear");
{
  const agents = [helper("readme", undefined), helper("tests", undefined)];
  check("ungrouped helpers survive", helpersForWakePrompt(agents).length, 2);
}
{
  const group = "2026-07-25T04:00:00Z";
  const agents = [helper("readme", undefined), helper("review 1", group), helper("review 2", group)];
  const shown = helpersForWakePrompt(agents);
  check("both kinds appear together", shown.length, 3);
  ok("the group members are present", shown.filter((a) => a.groupStartedAt === group).length === 2);
}
check("no helpers at all", helpersForWakePrompt([]), []);

section("The wake prompt carries the artifact, and the step still leads");
{
  const loop = {
    id: "l1", goal: "ship the thing", status: "sleeping", iterations: 1, maxIterations: 8,
    steps: ["draft the readme", "review it"], stepIndex: 1,
    history: [turn(1, CODE_REPLY)]
  };
  const prompt = composeWakePrompt(loop);
  ok("the step text leads the prompt", prompt.startsWith("review it"));
  ok("the artifact is present", prompt.includes("return a + b;"));
  ok("the code fence survived into the prompt", prompt.includes("```js"));
  // Ordering matters: the artifact is the longest thing in the prompt, so it
  // must sit below the step or it becomes the dominant signal.
  ok("the artifact sits below the step", prompt.indexOf("return a + b;") > prompt.indexOf("review it"));
}
{
  // A plain goal loop keeps one conversation and has nothing to hand across,
  // so it must not grow an artifact block.
  const goalLoop = { id: "l2", goal: "ship it", status: "sleeping", iterations: 1, maxIterations: 8, history: [turn(1, CODE_REPLY)] };
  ok("a goal loop gets no artifact block", !composeWakePrompt(goalLoop).includes("previous step produced"));
}
{
  const firstTurn = { id: "l3", goal: "g", status: "sleeping", iterations: 0, maxIterations: 8, steps: ["draft", "review"], stepIndex: 0, history: [] };
  ok("turn one has no artifact block", !composeWakePrompt(firstTurn).includes("previous step produced"));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
