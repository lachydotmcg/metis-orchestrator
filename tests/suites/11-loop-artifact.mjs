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

const { captureArtifact, latestArtifact, helpersForWakePrompt, summariseTurn, composeWakePrompt, LOOP_ARTIFACT_LIMIT, evidenceFromOperations, trimToTail, extractLoopDecision, LOOP_EVIDENCE_MAX, artifactsForWakePrompt, LOOP_ARTIFACT_HISTORY, LOOP_ARTIFACT_TOTAL_BUDGET } =
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

section("Evidence: only operations that actually CHECKED something");
{
  const ops = [
    { label: "Wrote index.html", status: "complete" },
    { label: "Ran npm test", status: "complete", exitCode: 0 },
    { label: "Ran npm run build", status: "error", exitCode: 1, stderr: "TS2304: Cannot find name 'x'." },
    { label: "Checked the preview", status: "warning", consoleErrors: ["Uncaught TypeError: y is not a function"] }
  ];
  const evidence = evidenceFromOperations(ops);
  // A file write reports that something HAPPENED, not that it worked. Counting
  // it would let a loop "verify" itself by writing a file.
  check("a file write is not evidence", evidence.length, 3);
  ok("a passing command is", evidence.some((e) => e.label.includes("npm test") && e.status === "complete"));
  ok("its exit code travels", evidence.find((e) => e.label.includes("npm test")).exitCode === 0);
  ok("a failing command is", evidence.some((e) => e.status === "error" && e.exitCode === 1));
  ok("and carries why it failed", evidence.find((e) => e.status === "error").detail.includes("TS2304"));
  ok("a browser check with console errors is", evidence.some((e) => e.label.includes("preview")));
  ok("and carries the console error", evidence.find((e) => e.label.includes("preview")).detail.includes("TypeError"));
  // A passing command needs no detail — the exit code says everything.
  check("a passing command carries no noise", evidence.find((e) => e.label.includes("npm test")).detail, undefined);
}
check("no operations", evidenceFromOperations([]), []);
check("undefined", evidenceFromOperations(undefined), []);
{
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `cmd ${i}`, status: "complete", exitCode: 0 }));
  check("evidence is bounded", evidenceFromOperations(many).length, LOOP_EVIDENCE_MAX);
}

section("Failure detail keeps the END, where the error is");
{
  // The opposite of captureArtifact's middle-trim, and deliberately so: a stack
  // trace's useful line is the last one, so keeping the head keeps the part
  // that says nothing.
  const trace = `${"boilerplate\n".repeat(200)}Error: the thing that actually broke`;
  const trimmed = trimToTail(trace, 120);
  ok("the real error survives", trimmed.includes("the thing that actually broke"));
  ok("it is bounded", trimmed.length <= 121);
  ok("it marks the cut", trimmed.startsWith("…"));
  check("short text is untouched", trimToTail("brief", 120), "brief");
}

section("Evidence reaches the next turn's prompt");
{
  const withEvidence = {
    id: "l4", goal: "get the tests passing", status: "sleeping", iterations: 1, maxIterations: 8,
    history: [{ index: 1, at: "2026-08-06T00:00:00Z", summary: "tried a fix", decision: "continue",
      evidence: [{ label: "Ran npm test", status: "error", exitCode: 1, detail: "3 failing" }] }]
  };
  const prompt = composeWakePrompt(withEvidence);
  ok("the check is named", prompt.includes("Ran npm test"));
  ok("the outcome is there", prompt.includes("error"));
  ok("the exit code is there", prompt.includes("exit 1"));
  ok("and why", prompt.includes("3 failing"));
  // The goal must still lead — evidence is scaffolding, same rule as the
  // artifact block.
  ok("the goal still leads", prompt.startsWith("get the tests passing"));
}
{
  const noEvidence = { id: "l5", goal: "g", status: "sleeping", iterations: 1, maxIterations: 8, history: [turn(1, "x")] };
  ok("a turn that checked nothing adds no block", !composeWakePrompt(noEvidence).includes("last turn checked"));
}

section('The third verdict: "blocked" is a stop that does not claim success');
{
  const blocked = extractLoopDecision('```metis-loop\n{"decision":"blocked","reason":"cannot verify without the dev server"}\n```');
  check("it parses", blocked.decision, "blocked");
  check("the reason survives", blocked.reason, "cannot verify without the dev server");
  // Blocked settles the loop, so it drops spawn and delay exactly as stop does:
  // a loop that cannot proceed must not leave helpers running behind it.
  const withSpawn = extractLoopDecision('```metis-loop\n{"decision":"blocked","reason":"stuck","spawn":[{"name":"a","task":"b"}],"delaySeconds":300}\n```');
  check("spawn is dropped", withSpawn.spawn, undefined);
  check("delay is dropped", withSpawn.delaySeconds, undefined);
}
// The governing rule is unchanged: anything unrecognised still stops the loop.
check("an invented verdict is still refused", extractLoopDecision('```metis-loop\n{"decision":"maybe"}\n```'), null);


section("Artifacts reach further back than one hop");
{
  // The failure this fixes: plan -> draft -> review -> synthesise, where the
  // final step whose whole job is combining could see only the review, never
  // the draft it was a review OF.
  const chain = { history: [
    { index: 1, at: "t1", summary: "s", decision: "continue", artifact: "THE-PLAN", step: "plan" },
    { index: 2, at: "t2", summary: "s", decision: "continue", artifact: "THE-DRAFT", step: "draft" },
    { index: 3, at: "t3", summary: "s", decision: "continue", artifact: "THE-REVIEW", step: "review" }
  ] };
  const picked = artifactsForWakePrompt(chain);
  check("three hops are carried", picked.length, 3);
  // Oldest first: a synthesise step reading them in order is reading the story
  // in order.
  check("oldest first", picked.map((p) => p.text), ["THE-PLAN", "THE-DRAFT", "THE-REVIEW"]);
  check("each is attributed", picked.map((p) => p.step), ["plan", "draft", "review"]);
}

section("Bounded by count and by total size");
{
  const many = { history: Array.from({ length: 10 }, (_, i) => ({ index: i, at: "t", summary: "s", decision: "continue", artifact: "a" + i, step: "step" + i })) };
  check("count is capped", artifactsForWakePrompt(many).length, LOOP_ARTIFACT_HISTORY);
  // Newest survives the cap, because the most recent output is the most likely
  // to matter.
  ok("the newest is kept", artifactsForWakePrompt(many).some((p) => p.text === "a9"));
  ok("the oldest is dropped", !artifactsForWakePrompt(many).some((p) => p.text === "a0"));
}
{
  const huge = "x".repeat(LOOP_ARTIFACT_TOTAL_BUDGET);
  const overBudget = { history: [
    { index: 1, at: "t", summary: "s", decision: "continue", artifact: "SMALL-OLD", step: "a" },
    { index: 2, at: "t", summary: "s", decision: "continue", artifact: huge, step: "b" }
  ] };
  const picked = artifactsForWakePrompt(overBudget);
  // An over-budget artifact is skipped WHOLE rather than truncated: half an
  // artifact is a lie about what the earlier step produced. Scanning continues,
  // so a smaller older one still fits.
  ok("the huge one fits alone", picked.some((p) => p.text === huge));
  ok("and the small one is skipped for budget", !picked.some((p) => p.text === "SMALL-OLD"));
}
check("no history", artifactsForWakePrompt({ history: [] }), []);

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
