// Ported from an ad-hoc scratch suite into the repo so it survives the session
// that wrote it. Runs against the COMPILED output in dist-electron, offline:
// no provider is called and no API key is read.

// Adversarial check of the loop decision layer. Every case is a way a model
// could fail to answer clearly. The property under test is the one that costs
// money if it breaks: ANYTHING AMBIGUOUS MUST STOP THE LOOP.
import { fromBuild } from "../harness.mjs";
const mod = await fromBuild("electron/loops.js");
const { extractLoopDecision, clampLoopDelay, loopTerminalReason, composeWakePrompt, summariseTurn,
        LOOP_MIN_DELAY_SECONDS, LOOP_MAX_DELAY_SECONDS } = mod;

const block = (body) => "Did the work.\n\n```metis-loop\n" + body + "\n```";
let pass = 0, total = 0;
function check(label, got, want) {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

console.log("DECISION PARSER — ambiguity must resolve to stop");
check("valid continue", extractLoopDecision(block('{"decision":"continue","delaySeconds":900,"reason":"CI running"}')),
  { decision: "continue", delaySeconds: 900, reason: "CI running" });
check("valid stop", extractLoopDecision(block('{"decision":"stop","reason":"done"}')),
  { decision: "stop", reason: "done" });

// The silence cases. Each of these MUST be null.
check("no block at all", extractLoopDecision("All finished, looks good!"), null);
check("prose 'I will continue'", extractLoopDecision("I'll continue working on this next round."), null);
check("empty block", extractLoopDecision(block("")), null);
check("malformed json", extractLoopDecision(block('{"decision":"continue",,}')), null);
check("array not object", extractLoopDecision(block('[{"decision":"continue"}]')), null);
check("missing decision field", extractLoopDecision(block('{"delaySeconds":600}')), null);
check("bogus decision value", extractLoopDecision(block('{"decision":"keep going"}')), null);
check("null input", extractLoopDecision(null), null);
check("undefined input", extractLoopDecision(undefined), null);
check("truncated mid-block", extractLoopDecision('```metis-loop\n{"decision":"contin'), null);

// Clamping — a model must not be able to request a hot loop or a parked one.
check("delay 0 floors", extractLoopDecision(block('{"decision":"continue","delaySeconds":0}')),
  { decision: "continue", delaySeconds: LOOP_MIN_DELAY_SECONDS, reason: undefined });
check("delay negative floors", extractLoopDecision(block('{"decision":"continue","delaySeconds":-500}')),
  { decision: "continue", delaySeconds: LOOP_MIN_DELAY_SECONDS, reason: undefined });
check("delay huge caps", extractLoopDecision(block('{"decision":"continue","delaySeconds":999999}')),
  { decision: "continue", delaySeconds: LOOP_MAX_DELAY_SECONDS, reason: undefined });
check("numeric string is honoured", extractLoopDecision(block('{"decision":"continue","delaySeconds":"900"}')),
  { decision: "continue", delaySeconds: 900, reason: undefined });
check("garbage string floors", extractLoopDecision(block('{"decision":"continue","delaySeconds":"soon"}')),
  { decision: "continue", delaySeconds: LOOP_MIN_DELAY_SECONDS, reason: undefined });
check("delay NaN floors", extractLoopDecision(block('{"decision":"continue","delaySeconds":null}')),
  { decision: "continue", delaySeconds: LOOP_MIN_DELAY_SECONDS, reason: undefined });
check("clampLoopDelay(Infinity)", clampLoopDelay(Infinity), LOOP_MAX_DELAY_SECONDS);
check("clampLoopDelay(NaN)", clampLoopDelay(NaN), LOOP_MIN_DELAY_SECONDS);

// A model that shows the example format then makes its real call must not have
// the EXAMPLE parsed as its decision.
const twoBlocks = "The format is:\n```metis-loop\n{\"decision\":\"continue\",\"delaySeconds\":60}\n```\nBut I'm done.\n```metis-loop\n{\"decision\":\"stop\",\"reason\":\"goal met\"}\n```";
check("last block wins over example", extractLoopDecision(twoBlocks), { decision: "stop", reason: "goal met" });

console.log("\nTERMINAL GUARD");
const base = { id: "x", goal: "g", origin: "app", permissionMode: "ask", status: "sleeping", iterations: 0,
  maxIterations: 3, createdAt: "2026-07-19T00:00:00Z", expiresAt: "2026-07-19T12:00:00Z", history: [] };
const now = new Date("2026-07-19T06:00:00Z");
check("healthy loop is not terminal", loopTerminalReason(base, now), null);
check("at cap is terminal", loopTerminalReason({ ...base, iterations: 3 }, now) !== null, true);
check("over cap is terminal", loopTerminalReason({ ...base, iterations: 9 }, now) !== null, true);
check("expired is terminal", loopTerminalReason(base, new Date("2026-07-20T00:00:00Z")) !== null, true);
check("stopped stays terminal", loopTerminalReason({ ...base, status: "stopped" }, now), "stopped");
check("failed stays terminal", loopTerminalReason({ ...base, status: "failed" }, now), "failed");

console.log("\nWAKE PROMPT");
const realGoal = { ...base, goal: "Read app.js and count the functions." };
const p1 = composeWakePrompt(realGoal);
// The routing bug that gutted a sandbox file: scaffolding must never lead, and
// must never contain a word that reads as a request to write something.
check("GOAL IS THE FIRST LINE", p1.split("\n")[0], realGoal.goal);
check("no build/make/create/write anywhere", /\b(build|make|create|write)\b/i.test(p1), false);
check("stays short so the goal dominates", p1.length < 600, true);
check("first turn says turn 1", p1.includes("Loop turn 1 of 3"), true);
check("carries the decision contract", p1.includes("metis-loop"), true);
check("warns silence stops", p1.includes("No block means the loop ends"), true);
const withHist = { ...base, iterations: 2, history: [
  { index: 1, at: "", summary: "read the files", decision: "continue" },
  { index: 2, at: "", summary: "listed the functions", decision: "continue" }] };
const p2 = composeWakePrompt(withHist);
check("goal still leads with history", p2.split("\n")[0], "g");
check("replays prior work", p2.includes("read the files") && p2.includes("listed the functions"), true);
check("says do not redo", p2.includes("do not redo"), true);
check("counts the turn", p2.includes("Loop turn 3 of 3"), true);

console.log("\nSUMMARY DIGEST");
check("strips the decision block", summariseTurn("Did it.\n```metis-loop\n{\"decision\":\"stop\"}\n```"), "Did it.");
check("collapses code fences", summariseTurn("Here:\n```js\nconst a=1;\n```"), "Here: (code)");
check("empty text is honest", summariseTurn(""), "(no reply text)");
check("truncates long text", summariseTurn("x".repeat(500)).length <= 240, true);

console.log(`\n  ${pass}/${total} checks correct`);
process.exit(pass === total ? 0 : 1);
