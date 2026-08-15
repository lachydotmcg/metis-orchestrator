// Named outputs and the conditional edge — flowchart v2 piece 1. Imports the
// real grammar and the real program-counter rule from the build.
//
// What this closes. Until now `stepIndex` only ever advanced `(i + 1) % len`,
// in exactly two places: the chain was a ring with no branches, so the "Pass?"
// diamond from the reference flowchart was inexpressible and the only verdict
// that steered anything was continue/stop — which decides WHETHER, never WHERE.
//
// Two rules here are load-bearing and both are the kind a later tidy-up breaks:
//
//   1. SILENCE FALLS THROUGH. An unreadable gate verdict degrades a gated chain
//      to exactly the chain it would have been without the gate. Guessing FAIL
//      turns every flaky judge into an infinite retry; guessing PASS makes a
//      broken judge look like a working one.
//   2. THE GATE HAS A CEILING. A conditional edge with no attempt limit is an
//      infinite loop wearing a condition, and this one runs unattended.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { parseLoopCommand, parseStepChain, parseGateSpec, stepInstruction, stepVariableName, stepVariableRefs, describeLoopCommand, expandStepFanout, fanoutMemberPosition, LOOP_COMMAND_MAX_GATE_ATTEMPTS, LOOP_COMMAND_MAX_HELPERS_TOTAL } =
  await fromBuild("shared/loop-command.js");
const { extractGateVerdict, gateAppliesToTurn, nextStepIndex, gatePromptFor, composeWakePrompt, parallelInstanceBrief, LOOP_MAX_SPAWNED_TOTAL } = await fromBuild("electron/loops.js");

section("A step can name what it produces");
{
  check("the declaration is read", stepVariableName("draft the post as $draft"), "draft");
  check("case does not matter", stepVariableName("draft as $Draft"), "draft");
  check("a step with no declaration names nothing", stepVariableName("draft the post"), null);
  // THE POINT OF STRIPPING IT. "draft the post as $draft" handed to a 7B is an
  // invitation to write the literal "$draft" into the answer, and the
  // declaration is Metis's bookkeeping rather than part of the instruction.
  check("the model is told the instruction only", stepInstruction("draft the post as $draft"), "draft the post");
  check("a step with no declaration is unchanged", stepInstruction("draft the post"), "draft the post");
  check("references are found", stepVariableRefs("revise $draft using $notes"), ["draft", "notes"]);
  check("a step's own declaration is not a reference to itself", stepVariableRefs("draft as $draft"), []);
}

section("A reference to a name nothing declares is a typo, not a no-op");
{
  // Caught in the composer. Otherwise "$draf" becomes a literal in a prompt and
  // quietly does nothing, which is indistinguishable from the feature not
  // working.
  const bad = parseStepChain("plan -> revise $draf");
  ok("an undeclared name is refused", /\$draf/.test(bad.error ?? ""));
  ok("and the fix is named", /as \$draf/.test(bad.error ?? ""));
  // A chain is a ring, so a later declaration would work on the second pass and
  // not the first — the worst kind of intermittent.
  const late = parseStepChain("revise $draft -> draft as $draft");
  ok("a forward reference is refused", Boolean(late.error));
  const twice = parseStepChain("draft as $x -> redraft as $x");
  ok("a name declared twice is refused", /named twice/.test(twice.error ?? ""));
  const empty = parseStepChain("plan -> as $draft");
  ok("a step that is only a declaration is refused", /nothing to do/.test(empty.error ?? ""));
  // Group members run side by side, so neither can see the other's output.
  const sibling = parseStepChain("plan -> draft as $d & revise $d");
  ok("a group member cannot reference its own sibling", Boolean(sibling.error));
  const good = parseStepChain("plan -> draft as $draft -> review $draft as $notes -> revise $draft using $notes");
  ok("the doc's own example parses", !good.error && good.steps.length === 4);
}

section("The gate resolves names to POSITIONS at parse time");
{
  const { steps } = parseStepChain("plan -> draft -> synthesise -> publish");
  const gate = parseGateSpec("synthesise fails -> draft", steps);
  check("the judged position", gate.gate.at, 2);
  check("the jump target", gate.gate.target, 1);
  // Positions, not names: an edited chain must not silently repoint an edge at
  // whatever step happens to carry that text now.
  const unknown = parseGateSpec("polish fails -> draft", steps);
  ok("a step that is not in the chain is an error", /not a step in this chain/.test(unknown.error ?? ""));
  ok("and the real steps are listed", /plan -> draft/.test(unknown.error ?? ""));
  const malformed = parseGateSpec("synthesise -> draft", steps);
  ok("the rule needs the word fails", /fails ->/.test(malformed.error ?? ""));
  // A self-edge means "try that step again", which is meaningful.
  check("a step may fail back to itself", parseGateSpec("draft fails -> draft", steps).gate.target, 1);
  // A group has no single output for a verdict to be about.
  const grouped = parseStepChain("plan -> a & b -> done");
  ok("a group cannot be gated", /parallel group/.test(parseGateSpec("a fails -> plan", grouped.steps).error ?? ""));
  // The declaration is bookkeeping, so a gate may name the step either way.
  const named = parseStepChain("plan -> draft as $draft -> review");
  check("a gate can name a step by its instruction", parseGateSpec("draft fails -> plan", named.steps).gate.at, 1);
}

section("The command accepts the gate in either order");
{
  const after = parseLoopCommand('/loop --steps "plan -> draft -> synthesise" --gate "synthesise fails -> draft" tidy up');
  check("gate after steps", after.parts.gate, { at: 2, target: 1, attempts: 3 });
  // Flags are typed in any order, and the gate can only be validated against a
  // chain that has already been parsed — so it resolves last.
  const before = parseLoopCommand('/loop --gate "synthesise fails -> draft" --steps "plan -> draft -> synthesise" tidy up');
  check("gate before steps", before.parts.gate, { at: 2, target: 1, attempts: 3 });
  check("attempts are settable", parseLoopCommand('/loop --steps "a -> b" --gate "b fails -> a" --gate-attempts 5').parts.gate.attempts, 5);
  ok(
    "over the cap is refused",
    /capped at 5/.test(parseLoopCommand('/loop --steps "a -> b" --gate "b fails -> a" --gate-attempts 9').error ?? "")
  );
  // A ceiling on a gate that does not exist reads as configured and does
  // nothing.
  ok("attempts without a gate is refused", /only means something with --gate/.test(parseLoopCommand("/loop --gate-attempts 3 do things").error ?? ""));
  ok("a gate without a chain is refused", /needs a chain/.test(parseLoopCommand('/loop --gate "a fails -> b" do things').error ?? ""));
  ok("the flag list mentions the new flags", /--gate/.test(parseLoopCommand("/loop --nope x").error ?? ""));
  const hint = describeLoopCommand(parseLoopCommand('/loop --steps "plan -> draft -> synthesise" --gate "synthesise fails -> draft"'));
  ok("the composer explains the gate", hint.some((segment) => segment.label.includes("gate on")));
  ok("and where a fail goes", hint.some((segment) => segment.meaning.includes("back to")));
}

section("Role fan-out: one written step, N run steps");
{
  const { steps } = parseStepChain("draft -> review x3 -> synthesise");
  check("the chain still has three positions", steps.length, 3);
  // DISTINCT NAMES. Three members called "review" work — the group's
  // completion check counts agents in a time window rather than matching
  // identities — but the panel, the audit log and the helper digest replayed
  // into the next wake prompt would all show the same word three times, and a
  // digest that cannot tell its own reviewers apart is one the next step
  // cannot reason about.
  check("the fan-out expands, distinctly", steps[1], ["review 1of3", "review 2of3", "review 3of3"]);
  check("a plain step is untouched", steps[0], "draft");
  // Bounded by the same ceiling as a "&" group, and caught in the composer
  // rather than at launch — a fan-out refused hours later, unattended, is the
  // failure this parse-time check exists to prevent.
  ok("over the group cap is refused", /over the 3-way limit/.test(parseStepChain("draft -> review x4").error ?? ""));
  // Multiplying two ceilings together is refused with the equivalent spelling
  // rather than silently truncated.
  ok("a fan-out inside a group is refused", /on its own/.test(parseStepChain("draft -> review x2 & summarise").error ?? ""));
  // A fan-out of one is a step, not a group of one: a group launches helpers
  // and waits, which for one member is strictly more machinery than running
  // it inline.
  check("x1 stays a single step", parseStepChain("draft -> review x1").steps[1], "review");
  check("x0 is not a fan-out", expandStepFanout("review x0"), null);
  check("a bare count with no step is not a fan-out", expandStepFanout("x3"), null);
  check("a step merely containing x3 is untouched", expandStepFanout("check the x3 config"), null);
}

section("A parallel instance is told the others exist, and nothing invented");
{
  check("the suffix is readable back", fanoutMemberPosition("review 2of3"), { index: 2, total: 3 });
  check("an ordinary step has no position", fanoutMemberPosition("review"), null);
  check("a nonsense position is refused", fanoutMemberPosition("review 5of3"), null);

  const brief = parallelInstanceBrief(2, 3);
  ok("it says which one you are", brief.includes("instance 2 of 3"));
  ok("and that the others are on the same material", /same material/.test(brief));
  ok("and that a first reading is already covered", /first pass would miss/.test(brief));
  // THE REFUSAL. Generic angles read well against "review" and are nonsense
  // against "research competitors", and a chain step is free text Metis has no
  // way to classify. Inventing subject matter for somebody's step is the same
  // failure as inventing a savings figure — it demos well and is silently
  // wrong half the time.
  ok("it invents no subject matter", !/correctness|clarity|completeness|security|performance|style/i.test(brief));
  // Saying nothing new is a permitted outcome. Three instances forced to
  // differ will manufacture disagreement.
  ok("finding nothing is an allowed answer", /nothing the others would not/.test(brief));
}

section("The helper allowance is stated before the loop runs, not after");
{
  // Running out settles the loop `exhausted` rather than degrading, so the
  // number belongs in the composer where it can still change a mind.
  const hint = describeLoopCommand(parseLoopCommand('/loop --steps "draft -> review x3 -> synthesise"'));
  const parallel = hint.find((segment) => segment.label === "3 in parallel");
  ok("the fan-out width is shown", Boolean(parallel));
  ok("with the cycles it buys", /3 cycles before the 9-helper allowance/.test(parallel?.meaning ?? ""));
  // A chain with no group says nothing about helpers, because it uses none.
  ok("a plain chain makes no such claim", !describeLoopCommand(parseLoopCommand('/loop --steps "a -> b"')).some((segment) => segment.label.includes("parallel")));
}

section("The duplicated helper ceiling has not drifted");
{
  // shared/loop-command.ts cannot import electron/loops.ts (renderer vs main),
  // so the number the hint spends is a copy. A copy that drifts turns the
  // composer's promise into a lie without failing anything else.
  check("the shared copy matches the real cap", LOOP_COMMAND_MAX_HELPERS_TOTAL, LOOP_MAX_SPAWNED_TOTAL);
}

section("Reading a verdict");
{
  check("PASS", extractGateVerdict("PASS"), "pass");
  check("FAIL", extractGateVerdict("FAIL the tests still fail"), "fail");
  check("lowercase", extractGateVerdict("fail"), "fail");
  // Ambiguity resolves toward going BACK: that costs a turn, while a wrong PASS
  // ships the failure. Mirrors extractLoopDecision's rule with the safe
  // direction pointing the other way, for the same reason.
  check("fail wins a reply containing both", extractGateVerdict("PASS looks fine\nFAIL actually the build is broken"), "fail");
  check("a closed think block is stripped", extractGateVerdict("<think>FAIL maybe</think>\nPASS"), "pass");
  check("an unterminated one too", extractGateVerdict("<think>\nPASS if the tests are green"), null);
  // SILENCE FALLS THROUGH.
  check("prose is not a verdict", extractGateVerdict("The step looks reasonable to me."), null);
  check("empty is not a verdict", extractGateVerdict(""), null);
  check("an echoed menu is not a verdict", extractGateVerdict("PASS <if it did its job>"), null);
}

section("The gate only fires where it should");
{
  const gated = { steps: ["plan", "draft", "synthesise"], stepIndex: 2, gate: { at: 2, target: 1, attempts: 3 }, gateUsed: 0 };
  ok("on its own step", gateAppliesToTurn(gated, 2));
  ok("not on another step", !gateAppliesToTurn(gated, 1));
  ok("not on a chain with no gate", !gateAppliesToTurn({ steps: ["a", "b"], stepIndex: 0 }, 0));
  ok("not on a group position", !gateAppliesToTurn(gated, null));
  // THE CEILING. A conditional edge with no attempt limit is an infinite loop
  // wearing a condition, and this one runs unattended.
  ok("not once the attempts are spent", !gateAppliesToTurn({ ...gated, gateUsed: 3 }, 2));
  ok("the cap is the documented one", LOOP_COMMAND_MAX_GATE_ATTEMPTS === 5);
}

section("Where the program counter goes");
{
  const gated = { steps: ["plan", "draft", "synthesise"], stepIndex: 2, gate: { at: 2, target: 1, attempts: 3 }, gateUsed: 0 };
  check("a fail goes BACK to the target", nextStepIndex(gated, "fail"), 1);
  check("a pass advances normally", nextStepIndex(gated, "pass"), 0);
  // Silence is the whole safety property: a gated chain with an unreachable
  // judge behaves exactly like an ungated one.
  check("silence advances normally", nextStepIndex(gated, null), 0);
  check("a spent gate advances even on a fail", nextStepIndex({ ...gated, gateUsed: 3 }, "fail"), 0);
  check("a fail on an ungated step advances", nextStepIndex({ ...gated, stepIndex: 0 }, "fail"), 1);
  check("the ring still wraps", nextStepIndex({ steps: ["a", "b"], stepIndex: 1 }, null), 0);
  check("a plain goal loop has no counter to move", nextStepIndex({ goal: "g" }, "fail"), undefined);
}

section("The judge is given the step, not the protocol");
{
  const prompt = gatePromptFor({
    goal: "ship the landing page",
    step: "synthesise the reviews as $final",
    produced: "Merged all three reviews.",
    evidence: [{ label: "npm test", status: "error", exitCode: 1 }]
  });
  ok("it is told it did not do the work", /did not do this work/i.test(prompt));
  ok("the bookkeeping is stripped from the step", !prompt.includes("$final"));
  ok("the evidence reaches it", prompt.includes("npm test") && prompt.includes("exit 1"));
  // One job per call — the same lesson followups.ts learned and
  // decideLoopContinuation inherited. A gate prompt carrying the loop protocol
  // would invite a small model to answer the wrong question.
  ok("no loop protocol leaks in", !/metis-loop|CONTINUE|delaySeconds/.test(prompt));
  ok("it is told to judge the step, not the goal", /not the whole goal/i.test(prompt));
}

section("Named outputs reach the step that asks for them, and only that step");
{
  const base = {
    id: "l", goal: "g", origin: "app", permissionMode: "auto", status: "sleeping",
    iterations: 1, maxIterations: 5, createdAt: "", expiresAt: "", history: [],
    steps: ["draft as $draft", "review", "revise $draft"],
    variables: { draft: "THE DRAFT TEXT" }
  };
  const asking = composeWakePrompt({ ...base, stepIndex: 2 });
  ok("the value is injected for a step that references it", asking.includes("THE DRAFT TEXT"));
  ok("labelled with the name", asking.includes("$draft"));
  // Injecting every variable a chain ever declared would be the artifact
  // channel again with extra steps. The point of naming is that a step says
  // which earlier output it means.
  const notAsking = composeWakePrompt({ ...base, stepIndex: 1 });
  ok("and NOT for a step that does not", !notAsking.includes("THE DRAFT TEXT"));
  // The declaration never reaches the model.
  const declaring = composeWakePrompt({ ...base, stepIndex: 0 });
  check("the declaring step leads with its instruction alone", declaring.split("\n")[0], "draft");
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
