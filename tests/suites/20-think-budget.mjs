// The think-token ceiling and the promotion it triggers. Imports the real rule
// from the build.
//
// What this exists to protect. Depths guesses once: pickDepthRung judges a turn,
// sends it to the matching model, and never revisits. Every other correction
// mechanism in the app reacts to a failure — fallback chains to an outage, the
// critic loop to a bad stage, the loop judge to a finished turn — and routing
// had no failure signal at all. A turn misjudged as trivial just produced a bad
// cheap answer and nothing anywhere noticed.
//
// A model that will not stop thinking IS that signal, and it arrives before the
// answer is paid for. Two rules make it safe, and both are pinned here because
// both are easy to "simplify" into something worse:
//
//   1. Thinking only counts while it is ALL the model has produced. Once an
//      answer has started the deliberation is over, and killing the stream then
//      throws away a real answer to punish a long preamble.
//   2. Promotion goes UP the internal scale (1 trivial → 3 deep). The node UI
//      counts the other way, so an inverted reading here would hand a
//      struggling turn to something cheaper.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const {
  DEFAULT_THINK_TOKEN_CEILING,
  THINK_CHARS_PER_TOKEN,
  thinkCeilingChars,
  shouldPromoteForThinking,
  promotedDepth,
  ThinkBudgetExceededError,
  isThinkBudgetError
} = await fromBuild("shared/think-budget.js");

section("The ceiling is a runaway detector, not a brevity rule");
{
  // A tight cap would fire on models that are merely thorough, and every false
  // positive spends a call on a rung that did not need one. The failure this
  // catches runs to thousands of tokens.
  ok("the default is generous", DEFAULT_THINK_TOKEN_CEILING >= 1000);
  check("tokens convert at the same ratio the usage ledger uses", thinkCeilingChars(100), 100 * THINK_CHARS_PER_TOKEN);
  check("a zero ceiling means no ceiling", thinkCeilingChars(0), 0);
  check("so does a negative one", thinkCeilingChars(-5), 0);
  check("and so does junk", thinkCeilingChars(Number.NaN), 0);
}

section("An answer already started is never killed");
{
  // THE RULE THAT MAKES THIS SAFE. A model that has begun writing has finished
  // deliberating; aborting now discards a real answer.
  ok(
    "long thinking plus a started answer is left alone",
    !shouldPromoteForThinking({ thoughtChars: 99_999, outputChars: 1, ceilingChars: 100 })
  );
  ok(
    "long thinking with nothing to show promotes",
    shouldPromoteForThinking({ thoughtChars: 101, outputChars: 0, ceilingChars: 100 })
  );
  ok("exactly at the ceiling is still allowed", !shouldPromoteForThinking({ thoughtChars: 100, outputChars: 0, ceilingChars: 100 }));
}

section("Off is off");
{
  // The feature is opt-in through Depths, and off has to be byte-identical to
  // before it existed — a ceiling of 0 must never abort anything.
  ok("no ceiling never promotes", !shouldPromoteForThinking({ thoughtChars: 10_000_000, outputChars: 0, ceilingChars: 0 }));
}

section("Promotion goes UP the internal scale");
{
  // Internally 1 is trivial and 3 is deep. The node UI counts the other way
  // (L1 hardest), which is why every user-facing string maps through 4 - depth.
  // Reading this backwards would demote a struggling turn onto something
  // cheaper, which is the exact opposite of the mechanism.
  check("trivial promotes to standard", promotedDepth(1), 2);
  check("standard promotes to deep", promotedDepth(2), 3);
  // A refusal, not an omission: the deepest rung has no better model behind it,
  // and re-running the same one doubles the bill to reproduce the same failure.
  check("deep has nowhere to go", promotedDepth(3), null);
}

section("The overrun is its own error type");
{
  // Three failures reach the same catch: a user pressing Stop, a provider
  // falling over, and this. The first two mean "do not retry" and this one
  // means "retry HIGHER", so collapsing them into a shared type would either
  // retry a cancellation or fail a promotable turn.
  const error = new ThinkBudgetExceededError(4321);
  ok("it is recognised", isThinkBudgetError(error));
  check("it carries how much thinking happened", error.thoughtChars, 4321);
  ok("an ordinary error is not mistaken for one", !isThinkBudgetError(new Error("Ollama returned HTTP 500")));
  ok("nor is a non-error", !isThinkBudgetError("aborted"));
  // Recognition is by name rather than by instanceof, because the error crosses
  // a module boundary and instanceof is what breaks first when a build emits
  // two copies of a class.
  const lookalike = new Error("x");
  lookalike.name = "ThinkBudgetExceededError";
  ok("a matching name is enough", isThinkBudgetError(lookalike));
}

section("The walkthrough prints both rungs when a turn was promoted");
{
  const { formatWalkthrough } = await fromBuild("shared/walkthrough.js");
  const base = {
    loopId: "l1",
    goal: "g",
    status: "stopped",
    createdAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:10:00.000Z"
  };
  const promoted = formatWalkthrough({
    ...base,
    history: [{ index: 1, at: base.createdAt, decision: "stop", routing: { provider: "anthropic", model: "m", depth: 2, promotedFrom: 1 } }]
  });
  // The one row where the router admits it guessed wrong. Printing only the
  // rung that answered would report the turn as though it had been judged
  // correctly first time.
  ok("both rungs appear", promoted.includes("trivial → standard (L2), promoted"));
  const plain = formatWalkthrough({
    ...base,
    history: [{ index: 1, at: base.createdAt, decision: "stop", routing: { provider: "anthropic", model: "m", depth: 2 } }]
  });
  ok("an unpromoted turn claims nothing", !plain.includes("promoted"));
  const noop = formatWalkthrough({
    ...base,
    history: [{ index: 1, at: base.createdAt, decision: "stop", routing: { provider: "anthropic", model: "m", depth: 2, promotedFrom: 2 } }]
  });
  ok("a promotion to the same rung is not a promotion", !noop.includes("promoted"));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
