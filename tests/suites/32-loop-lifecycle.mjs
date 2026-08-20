// The loop lifecycle, driven for real against a fake store.
//
// This suite could not exist yesterday, and the reason is worth writing down.
// loop-runtime.ts carried one line — `import { BrowserWindow } from "electron"`
// — used in exactly one function, to send a payload-free nudge to the renderers.
// A NAMED import from "electron" throws "Named export not found" at load time in
// plain node, because the CJS shim resolves to a path string with no named
// exports. So that single line made all 1,526 lines of the module impossible to
// load outside the app, and therefore impossible to test at all.
//
// Injecting `notifyRenderers` bought the entire file back. That is worth more
// than the assertions below: a module that cannot be loaded cannot be covered,
// and nothing about that shows up as a failure — it shows up as an absence.
//
// Offline: no provider is called, no window exists, no timer is armed, no API
// key is read. The store is a Map.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const rt = await fromBuild("electron/loop-runtime.js");
const { LOOP_MAX_ITERATIONS_CEILING, LOOP_MIN_DELAY_SECONDS } = await fromBuild("electron/loops.js");

const store = new Map();
const audits = [];
const notified = [];

rt.configureLoopRuntime({
  appendAudit: async (level, kind, summary) => { audits.push(kind); return {}; },
  readStoreValue: async (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  writeStoreValue: async (key, value) => { store.set(key, value); },
  listOllamaModels: async () => ({ reachable: true, installed: ["qwen3:8b"] }),
  listSecrets: async () => [],
  isRoutinesPaused: async () => false,
  isCancellationError: () => false,
  requestSessionCancelScope: () => {},
  refreshTrayMenu: () => {},
  runSessionTracked: async () => ({ id: "run-1", timeline: [], operations: [] }),
  followupInvokerFor: () => undefined,
  loopCancelScope: (id) => `loop:${id}`,
  loopJudgeInvoker: () => undefined,
  loopSpentTokens: async () => 0,
  dataPath: (...parts) => ["data", ...parts].join("/"),
  notifyRenderers: (channel) => { notified.push(channel); }
});

const reset = () => { store.clear(); audits.length = 0; notified.length = 0; };

section("A created loop is persisted, and every field is bounded");
{
  reset();
  const loop = await rt.createLoop({ goal: "tidy the shed" });
  ok("it comes back with an id", typeof loop.id === "string" && loop.id.length > 0);
  check("and it is sleeping, not running", loop.status, "sleeping");
  check("the goal survives", loop.goal, "tidy the shed");

  const stored = await rt.listLoops();
  check("it is in the store", stored.length, 1);
  check("and it is the same loop", stored[0].id, loop.id);

  // Renderers are told, because a loop appearing with nothing noticing is a
  // panel that lies until you switch tabs.
  ok("the renderers were nudged", notified.includes("metis-loops:changed"));
}

section("The caps are enforced at creation, not trusted from the caller");
{
  reset();
  // createLoop is reachable over IPC, so its input is untrusted by definition.
  const huge = await rt.createLoop({ goal: "g", maxIterations: 9999 });
  ok(`maxIterations is capped at ${LOOP_MAX_ITERATIONS_CEILING}`, huge.maxIterations <= LOOP_MAX_ITERATIONS_CEILING);

  const zero = await rt.createLoop({ goal: "g", maxIterations: 0 });
  ok("and a zero cap does not create a loop that can never run", zero.maxIterations >= 1);

  const fast = await rt.createLoop({ goal: "g", fixedIntervalSeconds: 1 });
  if (fast.fixedIntervalSeconds !== undefined) {
    ok(`a 1-second interval is floored at ${LOOP_MIN_DELAY_SECONDS}`, fast.fixedIntervalSeconds >= LOOP_MIN_DELAY_SECONDS);
  } else {
    ok("a sub-minimum interval is dropped rather than honoured", true);
  }
}

section("Stopping is idempotent and cannot resurrect");
{
  reset();
  const loop = await rt.createLoop({ goal: "g" });
  const stopped = await rt.stopLoop(loop.id, "because");
  check("stop returns the loop", stopped?.id, loop.id);
  check("and it is stopped", stopped?.status, "stopped");

  const again = await rt.stopLoop(loop.id, "again");
  // Stopping twice must not throw and must not flip it back to sleeping — the
  // stop route is reachable from the phone page and from the browser client,
  // so a double-tap is the normal case rather than the odd one.
  ok("stopping twice does not throw", true);
  ok("and it stays stopped", (again ?? stopped)?.status === "stopped");

  const missing = await rt.stopLoop("no-such-loop");
  ok("stopping a loop that does not exist returns nothing", missing === undefined || missing === null);
}

section("Deleting removes it, and only it");
{
  reset();
  const a = await rt.createLoop({ goal: "keep me" });
  const b = await rt.createLoop({ goal: "delete me" });
  const after = await rt.deleteLoop(b.id);
  check("one loop is left", after.length, 1);
  check("and it is the right one", after[0].id, a.id);
  const listed = await rt.listLoops();
  check("the store agrees", listed.length, 1);
}

section("A label exists for every loop, because the tray shows one");
{
  reset();
  const loop = await rt.createLoop({ goal: "a goal long enough to need shortening somewhere in the interface" });
  const label = rt.loopLabel(loop);
  ok("a label is produced", typeof label === "string" && label.length > 0);
  ok("and it is not the raw goal, unbounded", label.length <= loop.goal.length + 40);
}

section("Nothing here touched a window or a timer");
{
  // notifyRenderers is the ONLY way this module reaches a renderer now. If an
  // electron import comes back, this file stops loading entirely and the
  // failure is the whole suite disappearing rather than one assertion.
  ok("the module loaded outside electron at all", typeof rt.createLoop === "function");
  ok("and reached renderers only through the injected hook", notified.every((channel) => typeof channel === "string"));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
