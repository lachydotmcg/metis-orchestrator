// The app's first main-to-renderer PUSH channel, guarded on the source.
//
// Why this needs a guard at all. Every other main-to-renderer channel in Metis
// is `event.sender.send` — a reply inside an `invoke`, addressed to whoever
// asked. That shape works for streaming a run the user started and not at all
// for work that starts from a timer: a loop tick has no `invoke` to reply
// inside. So the conversation feed polled every 20 seconds to ask whether a
// background turn had landed, and the Loops panel polled every 10.
//
// Four invariants, and each one is a thing a later change erodes without
// noticing:
//
//   1. The broadcast lives inside `mutateLoops`, the single choke point every
//      loop write already passes through. A future background writer is then
//      covered by construction rather than by whoever adds it remembering.
//   2. The push carries NO PAYLOAD. Loop records hold their whole history
//      including per-step artifacts; serialising the list on every write would
//      push tens of kilobytes through IPC to say "something moved". It is an
//      invalidation signal, and it is also why the channel leaks nothing.
//   3. The preload removes its listener BY NAME. `removeAllListeners` would
//      let one subscriber silently unhook another.
//   4. Both subscribers still work without it. An older preload has no
//      `onChanged`, and the callers fall back to their timers rather than to a
//      surface that never updates.
//
// Electron cannot be imported here, so these are asserted on the source the
// same way 14 asserts the conversation lock. That is the point: the shapes
// being prevented all read perfectly naturally.
//
// Offline: no provider is called and no API key is read.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { section, check, ok, summary } from "../harness.mjs";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
// Every main-process source, not just main.ts. The loop runtime was carved out
// to ./loop-runtime.ts on 2026-08-20 (docs/STRUCTURAL_DEBT.md item 1) and took
// these assertions with it — caught correctly, because the question is what the
// main process DOES and that stopped being one file. Reading the directory means
// the remaining carves do not break this suite again for the same reason.
const main = readdirSync(join(process.cwd(), "src", "electron"))
  .filter((file) => file.endsWith(".ts") || file.endsWith(".cts"))
  .map((file) => read("src", "electron", file))
  .join("\n");
const preload = read("src", "electron", "preload.cts");
const app = read("src", "renderer", "ui", "App.tsx");

section("The broadcast sits on the one choke point every loop write passes");
{
  const fn = main.indexOf("function broadcastLoopsChanged()");
  ok("the broadcaster exists", fn !== -1);
  const mutator = main.indexOf("function mutateLoops<T>(");
  ok("mutateLoops exists", mutator !== -1);
  const call = main.indexOf("broadcastLoopsChanged();", mutator);
  ok("and it is called from inside mutateLoops", call > mutator && call - mutator < 1600);
  // Exactly one call site. Scattering it across the individual writers is how a
  // background path added later ends up pushing nothing.
  check("one call site, not one per writer", [...main.matchAll(/^\s*broadcastLoopsChanged\(\);/gm)].length, 1);
  // It goes to every window: a second window would otherwise hold stale state
  // with no way to notice.
  ok("it reaches every window", /BrowserWindow\.getAllWindows\(\)/.test(main.slice(fn, fn + 900)));
  ok("and skips destroyed ones", /isDestroyed\(\)/.test(main.slice(fn, fn + 900)));
}

section("The push carries no payload");
{
  const fn = main.indexOf("function broadcastLoopsChanged()");
  const body = main.slice(fn, fn + 900);
  // A payload here would serialise every loop's history, with artifacts, on
  // every single write — to communicate one bit.
  ok("send is called with the channel only", /webContents\.send\("metis-loops:changed"\)/.test(body));
  ok("and never with a second argument", !/webContents\.send\("metis-loops:changed",/.test(main));
}

section("The preload unsubscribes by name");
{
  const at = preload.indexOf("onChanged:");
  ok("the subscription exists", at !== -1);
  const body = preload.slice(at, at + 500);
  ok("it returns an unsubscribe", /return \(\) =>/.test(body));
  ok("which removes one listener", /removeListener\("metis-loops:changed", listener\)/.test(body));
  // The blunt version would unhook every other subscriber on the same channel.
  ok("never removeAllListeners", !/removeAllListeners\("metis-loops:changed"\)/.test(preload));
}

section("Both subscribers survive a preload that does not have it");
{
  // Optional-chained calls, so an older preload degrades to the previous
  // polling rather than to a surface that never updates.
  const calls = [...app.matchAll(/onChanged\?\.\(/g)].length;
  ok(`${calls} subscribers, all optional-chained`, calls === 2);
  ok("the feed keeps a fallback timer", /const timer = unsubscribe \? null : window\.setInterval/.test(app));
  // The panel's timer is unconditional for a different reason: it also drives
  // the relative-time display, and a dropped push must not leave a "running"
  // badge on a loop that finished.
  ok("the panel keeps its timer either way", /unsubscribe \? 30_000 : 10_000/.test(app));
  ok("and both clean up after themselves", [...app.matchAll(/unsubscribe\?\.\(\);/g)].length === 2);
}

section("The snapshot id reaches the run, not just the audit log");
{
  // It went to the audit log and the lastProjectSnapshot key from the day
  // snapshots shipped, and never onto the run — so nothing reporting on a run
  // afterwards could name the backup that would undo it.
  ok("the write path returns it", /return \{ artifacts: fileArtifacts, snapshot: takenSnapshot \};/.test(main));
  ok("and the tool result carries it", /\.\.\.\(written\.snapshot \? \{ snapshot: written\.snapshot \} : \{\}\)/.test(main));
  // Captured per TURN. lastProjectSnapshot holds one slot, so by the time a
  // five-turn loop settles, four of its backups are unnameable from there.
  ok("the loop tick records it per turn", /turnSnapshot = run\.projectResult\?\.snapshot;/.test(main));
  ok("onto the iteration record", /snapshot: turnSnapshot,/.test(main));
}

section("An overruled continue is not reported as the loop stopping itself");
{
  // A loop that was overruled did NOT stop itself, and saying it did would
  // hide the disagreement that is the entire reason for asking a second model.
  ok("the override is tracked", /let judgeOverrode = false;/.test(main));
  ok("and changes how the stop reads", /judgeOverrode\s*\?\s*`an independent model judged this finished/.test(main));
  // A null verdict must KEEP the turn's own continue. Unlike the fallback
  // path, silence here is not the absence of a decision — the turn made one —
  // and an unreachable judge is not evidence against it.
  ok("only a non-continue verdict overrides", /if \(verdict && verdict\.decision !== "continue"\)/.test(main));
  // The judge was asked WHETHER to go on, not how: a confirmed continue keeps
  // the working model's delay and spawn requests.
  ok("a confirmed continue keeps the original decision", /keeps the ORIGINAL decision object/.test(main));
}

section("The docs stopped claiming nothing pushes");
{
  // The 20-second conversation poll survives only as the no-preload fallback,
  // which the section above pins. What must not survive is the DOC saying the
  // app has no push channel — it was written the same day the poll was, as the
  // honest limit of that change, and leaving it would make this one invisible.
  const limits = read("docs", "LIMITATIONS.md");
  ok("LIMITATIONS no longer says nothing pushes", !/nothing pushes background work to the renderer/.test(limits));
  ok("and records the channel instead", /broadcastLoopsChanged|push channel/.test(limits));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
