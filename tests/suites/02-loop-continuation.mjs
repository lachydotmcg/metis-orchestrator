// Ported from an ad-hoc scratch suite into the repo so it survives the session
// that wrote it. Runs against the COMPILED output in dist-electron, offline:
// no provider is called and no API key is read.

// The fallback decision call, which runs on an unattended paid loop. Every case
// here came out of the code review, and every one of them used to resolve
// toward CONTINUE, which is the expensive direction to be wrong in.
import { fromBuild } from "../harness.mjs";
const m = await fromBuild("electron/loops.js");
const { decideLoopContinuation } = m;

const reply = (output, source = "ollama") => () => Promise.resolve({ output, source });
const ask = (output, source) => decideLoopContinuation(reply(output, source), { goal: "g", whatHappened: "w", turnsLeft: 3 });

let pass = 0, total = 0;
async function check(label, promise, want) {
  total += 1;
  const got = await promise;
  const norm = got === null ? null : got.decision;
  const ok = norm === want;
  if (ok) pass += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)}${ok ? "" : ` got ${norm} want ${want}`}`);
}

console.log("HAPPY PATH");
await check("plain continue", ask("CONTINUE 300 four files remain"), "continue");
await check("plain stop", ask("STOP every function now has a comment"), "stop");
await check("lowercase", ask("continue 120 still going"), "continue");

console.log("\nTHE REVIEW'S FINDINGS (all used to return CONTINUE)");
await check(
  "echoed option menu then a real STOP",
  ask("CONTINUE <seconds> <short reason>\nSTOP the goal is met, every function has a comment"),
  "stop"
);
await check(
  "echoed menu with no real answer",
  ask("CONTINUE <seconds> <short reason>\nSTOP <short reason>"),
  null
);
await check(
  "prose starting with continue that means stop",
  ask("Continue? No, the work is done, so we should stop."),
  "stop"
);
await check(
  "UNTERMINATED think block with continue inside",
  ask("<think>\nCONTINUE if more files remain. Here none remain."),
  null
);
await check(
  "closed think block is still stripped",
  ask("<think>CONTINUE maybe</think>\nSTOP done"),
  "stop"
);
await check(
  "deliberation then a final decision",
  ask("Continue seems plausible at first.\nActually the goal is met.\nSTOP finished"),
  "stop"
);
await check(
  "two continues, last one wins (still continue)",
  ask("CONTINUE 60 first thought\nCONTINUE 900 on reflection, longer"),
  "continue"
);

console.log("\nUNITS (a bare number is seconds; a unit means what it says)");
async function delayOf(label, text, want) {
  total += 1;
  const r = await ask(text);
  const got = r && r.delaySeconds;
  const ok = got === want;
  if (ok) pass += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(58)}${ok ? "" : ` got ${got} want ${want}`}`);
}
await delayOf("CONTINUE 5 minutes is 300s, not 5", "CONTINUE 5 minutes between batches", 300);
await delayOf("CONTINUE 2 hours clamps to the 3600 ceiling", "CONTINUE 2 hours then recheck", 3600);
await delayOf("a bare number is still seconds", "CONTINUE 300 four files remain", 300);
await delayOf("CONTINUE 90s", "CONTINUE 90s more to do", 90);
await delayOf("no number falls back to the floor", "CONTINUE more work remains", 60);

console.log("\nBLOCKED: THE VERDICT THAT CLAIMS NOTHING");
await check("plain blocked", ask("BLOCKED nothing was run that would show the tests pass"), "blocked");
await check("lowercase blocked", ask("blocked I cannot tell from this"), "blocked");
// Both verdicts halt the loop, so this is not a safety ordering — it is about
// which claim is TRUE. `stop` asserts the goal was met; `blocked` says the
// judge could not tell. A model that said both has told us it could not tell,
// and recording that as a met goal is the one wrong answer that reads as
// success.
await check("blocked outranks stop", ask("STOP looks done\nBLOCKED but I never saw it run"), "blocked");
await check("blocked outranks continue", ask("CONTINUE 60 keep going\nBLOCKED I cannot verify"), "blocked");
await check("an echoed BLOCKED placeholder is not a verdict", ask("BLOCKED <short reason>"), null);
total += 1;
{
  const r = await ask("BLOCKED the build never ran");
  if (r && r.reason === "the build never ran") { pass += 1; console.log("  PASS  the blocked reason survives"); }
  else console.log(`  FAIL  the blocked reason survives, got ${r && r.reason}`);
}

console.log("\nTHE JUDGE IS SHOWN EVIDENCE, NOT ONLY PROSE");
total += 1;
{
  // The whole point of an independent judge is that it grades against what
  // RAN. If the evidence never reaches the prompt, the judge is just a second
  // opinion on the same paragraph.
  let seen = "";
  await decideLoopContinuation(
    (prompt) => { seen = prompt; return Promise.resolve({ output: "STOP done", source: "ollama" }); },
    {
      goal: "make the tests pass",
      whatHappened: "I fixed the failing test",
      turnsLeft: 2,
      evidence: [{ label: "npm test", status: "error", exitCode: 1, detail: "1 failing" }]
    }
  );
  const hasEvidence = seen.includes("npm test") && seen.includes("exit 1") && seen.includes("1 failing");
  const disownsTheWork = /did not do this work/i.test(seen);
  if (hasEvidence && disownsTheWork) { pass += 1; console.log("  PASS  evidence and the not-your-work framing both reach the judge"); }
  else console.log(`  FAIL  evidence reached: ${hasEvidence}, framing reached: ${disownsTheWork}`);
}
total += 1;
{
  // No evidence must not fabricate an empty section that reads as "nothing
  // failed".
  let seen = "";
  await decideLoopContinuation(
    (prompt) => { seen = prompt; return Promise.resolve({ output: "STOP done", source: "ollama" }); },
    { goal: "g", whatHappened: "w", turnsLeft: 1 }
  );
  if (!seen.includes("WHAT ACTUALLY RAN")) { pass += 1; console.log("  PASS  no evidence means no evidence section"); }
  else console.log("  FAIL  an empty evidence section was rendered");
}

console.log("\nSILENCE STILL STOPS THE LOOP");
await check("no decision at all", ask("I have finished the work."), null);
await check("empty reply", ask(""), null);
await check("placeholder result is never parsed", ask("CONTINUE 300 go", "placeholder"), null);
await check("thrown invoke", decideLoopContinuation(() => Promise.reject(new Error("x")), { goal: "g", whatHappened: "w", turnsLeft: 1 }), null);

console.log("\nTHE LAST-CONTINUE DELAY IS STILL CLAMPED");
const long = await ask("CONTINUE 999999 way too long");
await check("huge delay clamped, still continue", Promise.resolve(long), "continue");
total += 1;
if (long && long.delaySeconds === 3600) { pass += 1; console.log("  PASS  clamped to 3600"); }
else console.log(`  FAIL  clamped to 3600, got ${long && long.delaySeconds}`);

console.log(`\n  ${pass}/${total} checks correct`);
process.exit(pass === total ? 0 : 1);
