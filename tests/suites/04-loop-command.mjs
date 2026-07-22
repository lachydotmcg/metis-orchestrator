// Ported from an ad-hoc scratch suite into the repo so it survives the session
// that wrote it. Runs against the COMPILED output in dist-electron, offline:
// no provider is called and no API key is read.

// The /loop grammar. A typo here becomes an autonomous run doing the wrong
// thing, so every malformed input must be caught BEFORE the user presses enter.
import { fromBuild } from "../harness.mjs";
const m = await fromBuild("shared/loop-command.js");
const { parseLoopCommand, parseLoopDuration, formatLoopDuration, describeLoopCommand, parseTokenCount, formatTokenCount, parseStepChain } = m;

let pass = 0, total = 0;
function check(label, got, want) {
  total += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}

console.log("NOT A LOOP COMMAND (must not hijack ordinary prompts)");
check("plain prompt", parseLoopCommand("fix the header").isLoopCommand, false);
check("mentions loop mid-sentence", parseLoopCommand("refactor the loop in app.js").isLoopCommand, false);
check("different command", parseLoopCommand("/orchestration a landing page").isLoopCommand, false);
check("looks similar", parseLoopCommand("/loopy thing").isLoopCommand, false);
check("empty", parseLoopCommand("").isLoopCommand, false);
check("null safe", parseLoopCommand(null).isLoopCommand, false);

console.log("\nHAPPY PATH");
check("bare goal", parseLoopCommand("/loop count to nine").parts, { goal: "count to nine" });
check("leading space", parseLoopCommand("  /loop count to nine").parts, { goal: "count to nine" });
check("case insensitive", parseLoopCommand("/LOOP count to nine").parts, { goal: "count to nine" });
check("turns flag", parseLoopCommand("/loop --turns 5 count to nine").parts, { goal: "count to nine", turns: 5 });
check("every flag", parseLoopCommand("/loop --every 15m watch the build").parts, { goal: "watch the build", everySeconds: 900 });
check("both flags", parseLoopCommand("/loop --turns 3 --every 2h check CI").parts, { goal: "check CI", turns: 3, everySeconds: 7200 });
check("flags after goal words", parseLoopCommand("/loop check CI --turns 3").parts, { goal: "check CI", turns: 3 });
check("aliases", parseLoopCommand("/loop -n 4 --interval 90s go").parts, { goal: "go", turns: 4, everySeconds: 90 });
check("bare /loop is command with empty goal", parseLoopCommand("/loop").parts, { goal: "" });

console.log("\nMALFORMED — must be caught before enter, never silently defaulted");
check("unknown flag refused", Boolean(parseLoopCommand("/loop --turn 5 go").error), true);
check("unknown flag not swallowed into goal", parseLoopCommand("/loop --turn 5 go").parts, undefined);
check("--turns with no value", Boolean(parseLoopCommand("/loop --turns").error), true);
check("--turns non-numeric", Boolean(parseLoopCommand("/loop --turns abc go").error), true);
check("--turns zero", Boolean(parseLoopCommand("/loop --turns 0 go").error), true);
check("--turns negative", Boolean(parseLoopCommand("/loop --turns -3 go").error), true);
check("--turns fractional", Boolean(parseLoopCommand("/loop --turns 2.5 go").error), true);
check("--turns over cap", Boolean(parseLoopCommand("/loop --turns 99 go").error), true);
check("--turns at cap ok", parseLoopCommand("/loop --turns 25 go").parts?.turns, 25);
check("--every with no value", Boolean(parseLoopCommand("/loop --every").error), true);
check("--every unreadable", Boolean(parseLoopCommand("/loop --every soon go").error), true);
check("--every too short", Boolean(parseLoopCommand("/loop --every 5s go").error), true);
check("--every 2h now allowed (user is not a confused model)", parseLoopCommand("/loop --every 2h go").parts?.everySeconds, 7200);
check("--every beyond 6h refused", Boolean(parseLoopCommand("/loop --every 9h go").error), true);
check("--every at min ok", parseLoopCommand("/loop --every 60s go").parts?.everySeconds, 60);
check("--every at max ok", parseLoopCommand("/loop --every 6h go").parts?.everySeconds, 21600);
check("--budget with no value", Boolean(parseLoopCommand("/loop --budget").error), true);
check("--budget unreadable", Boolean(parseLoopCommand("/loop --budget lots go").error), true);
check("--budget below floor refused", Boolean(parseLoopCommand("/loop --budget 500 go").error), true);
check("--budget 200k", parseLoopCommand("/loop --budget 200k go").parts, { goal: "go", budgetTokens: 200000 });
check("--budget 1.5m", parseLoopCommand("/loop --budget 1.5m go").parts?.budgetTokens, 1500000);
check("--budget bare number", parseLoopCommand("/loop --budget 50000 go").parts?.budgetTokens, 50000);
check("--tokens alias", parseLoopCommand("/loop --tokens 12k go").parts?.budgetTokens, 12000);
check("--budget composes with other flags", parseLoopCommand("/loop --turns 3 --budget 20k go").parts, { goal: "go", turns: 3, budgetTokens: 20000 });

console.log("\nDURATION PARSING");
check("90s", parseLoopDuration("90s"), 90);
check("15m", parseLoopDuration("15m"), 900);
check("2h", parseLoopDuration("2h"), 7200);
check("bare number = minutes", parseLoopDuration("15"), 900);
check("long unit names", parseLoopDuration("15 minutes"), 900);
check("garbage", parseLoopDuration("soon"), null);
check("zero", parseLoopDuration("0m"), null);
check("negative", parseLoopDuration("-5m"), null);
check("empty", parseLoopDuration(""), null);
check("format 900", formatLoopDuration(900), "15m");
check("format 3600", formatLoopDuration(3600), "1h");
check("format 90", formatLoopDuration(90), "90s");

console.log("\nSTEP CHAINS (--steps, docs/FLOWCHART_LOOPS_DESIGN.md)");
check("quoted chain parses", parseLoopCommand('/loop --steps "read the files -> plan -> implement"').parts,
  { goal: "", steps: ["read the files", "plan", "implement"] });
check("unquoted single-token chain", parseLoopCommand("/loop --steps read->plan->implement").parts,
  { goal: "", steps: ["read", "plan", "implement"] });
check("chain plus goal text", parseLoopCommand('/loop --steps "a -> b" tidy the docs').parts,
  { goal: "tidy the docs", steps: ["a", "b"] });
check("chain composes with flags", parseLoopCommand('/loop --steps "a -> b" --turns 4 --budget 20k').parts,
  { goal: "", steps: ["a", "b"], turns: 4, budgetTokens: 20000 });
check("--steps with no value", Boolean(parseLoopCommand("/loop --steps").error), true);
check("unclosed quote refused", Boolean(parseLoopCommand('/loop --steps "read -> plan').error), true);
check("ampersand parses into a parallel group", parseLoopCommand('/loop --steps "a & b -> c"').parts?.steps, [["a", "b"], "c"]);
check("group binds tighter than the arrow", parseLoopCommand('/loop --steps "read -> research & review -> implement"').parts?.steps,
  ["read", ["research", "review"], "implement"]);
check("group over the helper cap refused", Boolean(parseLoopCommand('/loop --steps "a & b & c & d -> e"').error), true);
check("group at the helper cap ok", parseLoopCommand('/loop --steps "a & b & c -> e"').parts?.steps, [["a", "b", "c"], "e"]);
check("empty group member refused", Boolean(parseLoopCommand('/loop --steps "a & -> b"').error), true);
check("group members count toward the total cap", Boolean(parseStepChain("a & b & c -> d & e & f -> g -> h -> i").error), true);
check("parentheses still refused with a coming-later message", /not runnable yet/.test(parseLoopCommand('/loop --steps "(a -> b) & c -> d"').error ?? ""), true);
check("empty step refused", Boolean(parseLoopCommand('/loop --steps "a -> -> b"').error), true);
check("single step refused", Boolean(parseLoopCommand('/loop --steps "just one"').error), true);
check("nine steps over the cap", Boolean(parseStepChain("a->b->c->d->e->f->g->h->i").error), true);
check("eight steps at the cap ok", parseStepChain("a->b->c->d->e->f->g->h").steps?.length, 8);
check("hint shows the cycle", describeLoopCommand(parseLoopCommand('/loop --steps "a -> b"')).some((s) => s.label === "2-step cycle"), true);
check("chain-driven goal hint when no goal typed", describeLoopCommand(parseLoopCommand('/loop --steps "a -> b"'))[0].label, "chain-driven");

console.log("\nTOKEN COUNT PARSING");
check("bare 50000", parseTokenCount("50000"), 50000);
check("200k", parseTokenCount("200k"), 200000);
check("1.5m", parseTokenCount("1.5m"), 1500000);
check("commas stripped", parseTokenCount("50,000"), 50000);
check("'200k tokens' unit word ok", parseTokenCount("200k tokens"), 200000);
check("garbage", parseTokenCount("lots"), null);
check("zero", parseTokenCount("0"), null);
check("negative", parseTokenCount("-5k"), null);
check("empty", parseTokenCount(""), null);
check("format 200000", formatTokenCount(200000), "200k");
check("format 1500000", formatTokenCount(1500000), "1.5m");
check("format non-round exact", formatTokenCount(4321), "4321");

console.log("\nLIVE HINT (what the user reads while typing)");
const bare = describeLoopCommand(parseLoopCommand("/loop"));
check("bare shows 4 segments", bare.length, 4);
check("bare prompts for a goal", bare[0].typed, false);
check("bare shows default cap", bare[1].label, "8 turns");
check("bare shows self-paced default", bare[2].label, "self-paced");
check("bare shows no-budget default", bare[3].label, "no token budget");
const full = describeLoopCommand(parseLoopCommand("/loop --turns 3 --every 15m --budget 200k watch the build"));
check("typed goal marked typed", full[0].typed, true);
check("typed turns shown", full[1].label, "3 turns");
check("typed interval shown", full[2].label, "every 15m");
check("typed budget shown", full[3].label, "200k tokens");
check("error yields no hint", describeLoopCommand(parseLoopCommand("/loop --turn 5 go")).length, 0);
check("non-command yields no hint", describeLoopCommand(parseLoopCommand("hello")).length, 0);
check("every segment explains itself", full.every((s) => s.meaning.length > 0), true);

console.log(`\n  ${pass}/${total} checks correct`);
process.exit(pass === total ? 0 : 1);
