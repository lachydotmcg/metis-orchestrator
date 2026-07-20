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
