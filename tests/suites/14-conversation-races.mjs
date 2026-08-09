// The conversation store's lost-turn race, proved by running the OLD shape and
// the NEW shape against the same interleaving. Same method as
// 05-loop-store-races, because the bug is the same bug one store over.
//
// The scenario: appendRunToConversation read the whole conversation list, then
// awaited (a model call finishing, resources being claimed), then wrote a list
// built from the snapshot it took BEFORE that await. One writer at a time, that
// is only theoretical. Phase 2A stopped it being theoretical — a loop turn can
// spawn up to three helpers, each a full tracked run appending through this
// same store, so four writers hold four pre-await snapshots and the slowest one
// wins. A turn that was written, displayed and scrolled past is simply absent
// after a restart.
//
// The functions under test live in main.ts, which cannot be imported (it is an
// Electron entry point with side effects at load). So this models the two
// shapes exactly as 05 does, and asserts the property rather than the code.
// The value is the same: it pins WHY the serialiser exists, so removing it
// fails a build rather than quietly restoring the bug.
//
// Offline: no provider is called and no API key is read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { section, check, ok, summary } from "../harness.mjs";

let store = [];
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const read = async () => { await settle(5); return JSON.parse(JSON.stringify(store)); };
const write = async (next) => { await settle(5); store = JSON.parse(JSON.stringify(next)); };

const appendTurn = (list, id, text) => {
  const existing = list.find((c) => c.id === id);
  const conversation = existing ?? { id, turns: [] };
  const nextConversation = { ...conversation, turns: [...conversation.turns, text] };
  return [nextConversation, ...list.filter((c) => c.id !== id)];
};

// --- OLD: read, do slow work, then write a snapshot taken before it ---
async function oldAppend(id, text, slow) {
  const current = await read();
  await settle(slow);
  await write(appendTurn(current, id, text));
}

// --- NEW: serialised, and re-reads INSIDE the lock ---
let queue = Promise.resolve();
function mutate(mutator) {
  const run = queue.then(async () => {
    const current = await read();
    const { next, result } = mutator(current);
    await write(next);
    return result;
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
async function newAppend(id, text, slow) {
  // The slow part happens BEFORE the lock, which is the whole point: the model
  // call is not serialised, only the write is.
  await settle(slow);
  return mutate((current) => ({ next: appendTurn(current, id, text), result: current.length }));
}

const turnsFor = (id) => store.find((c) => c.id === id)?.turns ?? [];

section("The bug: concurrent appends lose turns");
{
  store = [];
  // A loop turn and three helpers, finishing in a staggered order, each
  // appending to its own conversation.
  await Promise.all([
    oldAppend("loop", "loop turn", 60),
    oldAppend("helper-1", "helper 1 done", 20),
    oldAppend("helper-2", "helper 2 done", 40),
    oldAppend("helper-3", "helper 3 done", 10)
  ]);
  check("four writers, but not four conversations survive", store.length < 4, true);
  ok("at least one conversation was lost entirely", store.length < 4);
  console.log(`      old shape kept ${store.length} of 4 conversations`);
}

section("Two turns on the SAME conversation: one is silently dropped");
{
  store = [];
  await Promise.all([oldAppend("chat", "first", 50), oldAppend("chat", "second", 10)]);
  check("only one turn survives", turnsFor("chat").length, 1);
}

section("The fix: every writer's work survives");
{
  store = [];
  queue = Promise.resolve();
  await Promise.all([
    newAppend("loop", "loop turn", 60),
    newAppend("helper-1", "helper 1 done", 20),
    newAppend("helper-2", "helper 2 done", 40),
    newAppend("helper-3", "helper 3 done", 10)
  ]);
  check("all four conversations are present", store.length, 4);
  for (const id of ["loop", "helper-1", "helper-2", "helper-3"]) {
    check(`"${id}" kept its turn`, turnsFor(id).length, 1);
  }
}

section("Two turns on the same conversation both land, in completion order");
{
  store = [];
  queue = Promise.resolve();
  await Promise.all([newAppend("chat", "slow", 50), newAppend("chat", "fast", 10)]);
  check("both turns survive", turnsFor("chat").length, 2);
  check("ordered by when each finished, not when each started", turnsFor("chat"), ["fast", "slow"]);
}

section("A throwing mutation must not wedge the queue");
{
  store = [];
  queue = Promise.resolve();
  const failed = mutate(() => {
    throw new Error("mutator blew up");
  }).then(() => "resolved", () => "rejected");
  check("the failing mutation rejects", await failed, "rejected");
  await newAppend("after", "still works", 5);
  check("the next write still lands", turnsFor("after"), ["still works"]);
}

section("Ordering is FIFO, so a fast writer cannot overtake a queued one");
{
  store = [];
  queue = Promise.resolve();
  const order = [];
  await Promise.all([
    mutate((c) => { order.push("a"); return { next: appendTurn(c, "x", "a"), result: 0 }; }),
    mutate((c) => { order.push("b"); return { next: appendTurn(c, "x", "b"), result: 0 }; }),
    mutate((c) => { order.push("c"); return { next: appendTurn(c, "x", "c"), result: 0 }; })
  ]);
  check("mutators ran in the order they were queued", order, ["a", "b", "c"]);
  check("and every one is in the result", turnsFor("x"), ["a", "b", "c"]);
}

section("Nothing writes the conversation store outside the lock");
{
  // The architectural guard, and the reason this suite can assert a property
  // it cannot import. Ten writers each did their own read-modify-write; they
  // were converted one at a time, and the eleventh would have been added the
  // same way by whoever writes the next feature, because the old shape reads
  // perfectly naturally. So the invariant is enforced on the source: exactly
  // one call site, and it is the one inside mutateConversations.
  const source = readFileSync(join(process.cwd(), "src", "electron", "main.ts"), "utf8");
  const callSites = [...source.matchAll(/await writeConversations\(/g)].length;
  check("writeConversations has exactly one call site", callSites, 1);

  const mutator = source.indexOf("function mutateConversations<T>(");
  ok("mutateConversations exists", mutator !== -1);
  const only = source.indexOf("await writeConversations(");
  ok("and the one call site is inside it", only > mutator && only - mutator < 400);

  // Reads are deliberately NOT restricted. A stale read shows a slightly old
  // list; it never destroys a turn, and forcing every reader through the queue
  // would serialise the UI behind whatever write is in flight.
  const reads = [...source.matchAll(/await readConversations\(\)/g)].length;
  ok(`${reads} unlocked reads are allowed on purpose`, reads > 1);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
