// Rolling the usage ledger up by Depths rung. Imports the real arithmetic from
// the build.
//
// The reason this suite leans on ABSENCE as much as on sums:
//
// The feature it implements (docs/COMPETITIVE_SWEEP.md #4) was proposed with a
// counterfactual — "you saved $X versus a frontier model" — and the doc then
// corrected itself, noting a frontier model would not take the same number of
// turns, and suggesting "same turns at frontier pricing" instead. Checking that
// correction, it does not survive either: TWO things differ when another model
// answers, the turn count and the tokens per turn, so pricing this run's exact
// token counts at another model's rate answers "what if a different model
// behaved identically to this one", which is a question about nothing. And the
// deeper problem is not arithmetic — the cheap rung's answer may simply have
// been worse, so money not spent is not necessarily money saved.
//
// So there is no counterfactual, and the last section here pins its absence.
// A savings figure is exactly the kind of thing that gets added back later
// because it demos well.
//
// Offline: no provider is called and no API key is read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { rollUpByRung, rungLabel, RUNG_LEDGER_NOTE } = await fromBuild("shared/rung-ledger.js");

const row = (depth, inputTokens, outputTokens, extra = {}) => ({ depth, inputTokens, outputTokens, ...extra });

section("Rungs are summed by the one that SERVED the run");
{
  const rolled = rollUpByRung([
    row(1, 100, 50),
    row(1, 200, 100),
    row(3, 10, 5),
    row(2, 40, 20)
  ]);
  const at = (depth) => rolled.find((bucket) => bucket.depth === depth);
  check("three rungs used", rolled.length, 3);
  check("runs are counted", at(1).runs, 2);
  check("tokens are summed", [at(1).inputTokens, at(1).outputTokens], [300, 150]);
  check("a single-run rung too", at(3).runs, 1);
  // An empty row invites the reader to wonder what happened on that rung, and
  // the answer is nothing.
  ok("unused rungs are dropped entirely", !rolled.some((bucket) => bucket.runs === 0 && bucket.promotedOut === 0));
}

section("Runs with no rung get their own bucket, never someone else's");
{
  // Depths is OFF by default, and rows written before the rung was captured
  // can never be labelled retroactively — so this bucket is normally the
  // biggest one. Folding it into a rung would attribute spend to a ladder that
  // was not running.
  const rolled = rollUpByRung([row(undefined, 100, 100), row(1, 10, 10), row(null, 5, 5)]);
  const unrecorded = rolled.find((bucket) => bucket.depth === null);
  check("both unlabelled rows land together", unrecorded.runs, 2);
  check("with their own tokens", unrecorded.inputTokens, 105);
  check("and the real rung keeps only its own", rolled.find((bucket) => bucket.depth === 1).inputTokens, 10);
  check("it is named honestly", rungLabel(null), "Not recorded");
}

section("A promotion is counted once, on both ends, without double-billing");
{
  // The tokens belong to the rung that ANSWERED — that is where the money
  // went. The abandoned rung records that it lost a turn, so the ladder's
  // error rate is visible without inflating anyone's spend.
  const rolled = rollUpByRung([row(2, 1000, 500, { depthPromotedFrom: 1 })]);
  const served = rolled.find((bucket) => bucket.depth === 2);
  const abandoned = rolled.find((bucket) => bucket.depth === 1);
  check("the serving rung got the run", served.runs, 1);
  check("and the tokens", served.inputTokens, 1000);
  check("and records it arrived by promotion", served.promotedIn, 1);
  check("the abandoned rung records the loss", abandoned.promotedOut, 1);
  // THE TRAP. The abandoned rung must not be credited with a run or a token.
  check("but not a run", abandoned.runs, 0);
  check("nor any tokens", abandoned.inputTokens + abandoned.outputTokens, 0);
  // It still appears, because "one turn started here and left" is a fact worth
  // showing even when nothing finished on that rung.
  ok("it is still listed", Boolean(abandoned));
}

section("Malformed promotion records are ignored rather than half-counted");
{
  // A stored row from an older build could carry one end without the other.
  const noServed = rollUpByRung([row(undefined, 10, 10, { depthPromotedFrom: 1 })]);
  ok("a promotion with no serving rung counts nothing", !noServed.some((bucket) => bucket.promotedIn || bucket.promotedOut));
  // Promoted to itself is not a promotion.
  const selfPromoted = rollUpByRung([row(2, 10, 10, { depthPromotedFrom: 2 })]);
  check("same-rung is not a promotion", selfPromoted.find((bucket) => bucket.depth === 2).promotedIn, 0);
  const junk = rollUpByRung([row(9, 10, 10), row("2", 10, 10)]);
  check("an out-of-range depth is not recorded", junk.find((bucket) => bucket.depth === null).runs, 2);
}

section("Estimated totals stay marked estimated");
{
  // Any estimated contributor makes the whole sum an estimate. Presenting a
  // mixed total as exact is the dishonest reading of it — same rule the
  // provider and model rollups already follow.
  const mixed = rollUpByRung([row(1, 10, 10), row(1, 10, 10, { estimated: true })]);
  ok("one estimated row flags the bucket", mixed.find((bucket) => bucket.depth === 1).estimated);
  const exact = rollUpByRung([row(1, 10, 10)]);
  ok("an all-exact bucket is not flagged", !exact.find((bucket) => bucket.depth === 1).estimated);
}

section("Labels use the USER-FACING scale, which is reversed");
{
  // Internally 1 is trivial and 3 is deep; the node UI counts L1 as the
  // hardest tier. Reading this backwards would report the cheap rung's spend
  // under the expensive rung's name — a wrong number that looks right.
  check("internal 3 (deep) is the user's L1", rungLabel(3), "L1");
  check("internal 1 (trivial) is the user's L3", rungLabel(1), "L3");
  check("the middle is unchanged", rungLabel(2), "L2");
}

section("There is no savings claim, and there must not be one");
{
  // The whole point of the doc's two corrections. A number like "you saved
  // $18" cannot be defended in the one conversation where it matters, and it
  // is exactly the sort of thing re-added later because it demos well.
  const rolled = rollUpByRung([row(1, 100, 100), row(3, 100, 100)]);
  const keys = Object.keys(rolled[0]).join(" ");
  ok("no bucket carries a saved/counterfactual field", !/saved|savings|counterfactual|wouldHave/i.test(keys));
  // And the note under the table says why, rather than leaving the reader to
  // assume the number is merely missing.
  ok("the note refuses the premise out loud", /no .you saved. figure/i.test(RUNG_LEDGER_NOTE));
  ok("and gives both reasons", /same turns/i.test(RUNG_LEDGER_NOTE) && /not automatically the equal one/i.test(RUNG_LEDGER_NOTE));
}

section("Both surfaces exist, because a recorded field with no screen is not a feature");
{
  // `run.depth` had been recorded since Depths shipped and rendered NOWHERE —
  // you could see which model answered and never which rung sent it there.
  // This suite would pass on the arithmetic alone while the ladder stayed
  // invisible, which is the failure mode worth guarding here specifically.
  const app = readFileSync(join(process.cwd(), "src", "renderer", "ui", "App.tsx"), "utf8");
  ok("the per-message badge exists", /function RungBadge\(/.test(app));
  ok("and is rendered on the route line", /<RungBadge run=\{run\} \/>/.test(app));
  // A promoted turn shows both ends: it is the one badge that says the router
  // judged this wrong and corrected itself.
  ok("a promoted turn shows both rungs", /rungLabel\(run\.depthPromotedFrom \?\? null\)\} → \$\{rungLabel\(run\.depth\)/.test(app));
  ok("the lifetime table exists", /usageSummary\?\.byRung\?\.length/.test(app));
  ok("and prints the honest note under it", /\{RUNG_LEDGER_NOTE\}/.test(app));

  // The ledger has to CARRY the rung or the table is permanently empty. Same
  // argument the existing attribution fields make in their own comment: rows
  // written before the field existed can never be labelled retroactively.
  const main = readFileSync(join(process.cwd(), "src", "electron", "main.ts"), "utf8");
  ok("the ledger records the serving rung", /depth: run\.depth,/.test(main));
  ok("and the rung it was promoted from", /depthPromotedFrom: run\.depthPromotedFrom/.test(main));
  ok("the summary rolls it up", /byRung: rollUpByRung\(ledger\)/.test(main));
}

section("Junk input never throws");
{
  check("empty", rollUpByRung([]), []);
  check("null", rollUpByRung(null), []);
  const sparse = rollUpByRung([{}, { depth: 1 }]);
  check("rows with no tokens count as runs", sparse.find((bucket) => bucket.depth === 1).runs, 1);
  check("with zero tokens", sparse.find((bucket) => bucket.depth === 1).inputTokens, 0);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
