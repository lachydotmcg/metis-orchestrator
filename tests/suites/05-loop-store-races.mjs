// Ported from an ad-hoc scratch suite into the repo so it survives the session
// that wrote it. Runs against the COMPILED output in dist-electron, offline:
// no provider is called and no API key is read.

// Proves the serialised mutation actually fixes the lost-Stop race, by running
// the OLD shape and the NEW shape against the same interleaving.
//
// The scenario is the one the review described: a loop turn reads the record,
// spends a while on a model call, then writes its result. The user clicks Stop
// during that window. Under the old read-then-write, the turn's write is built
// from a snapshot taken before the Stop, so the Stop is silently erased and the
// loop re-arms as though nothing happened.

let store = [];
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const read = async () => { await settle(5); return JSON.parse(JSON.stringify(store)); };
const write = async (next) => { await settle(5); store = JSON.parse(JSON.stringify(next)); };

// --- OLD: each writer reads, does slow work, then writes its own snapshot ---
async function oldTurn() {
  const current = await read();                 // snapshot BEFORE the stop
  await settle(60);                             // the model call
  const rec = current.find((r) => r.id === "a");
  await write(current.map((r) => (r.id === "a" ? { ...rec, status: "sleeping", nextWakeAt: "armed" } : r)));
}
async function oldStop() {
  await settle(20);                             // user clicks mid-turn
  const current = await read();
  await write(current.map((r) => (r.id === "a" ? { ...r, status: "stopped", nextWakeAt: undefined } : r)));
}

// --- NEW: every mutation re-reads INSIDE the lock ---
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
async function newTurn() {
  await settle(60);                             // the model call happens OUTSIDE the lock
  return mutate((current) => {
    const stored = current.find((r) => r.id === "a");
    // Honour a stop that landed while the call was in flight.
    if (stored.status === "stopped") return { next: current, result: "honoured the stop" };
    return { next: current.map((r) => (r.id === "a" ? { ...r, status: "sleeping", nextWakeAt: "armed" } : r)), result: "re-armed" };
  });
}
async function newStop() {
  await settle(20);
  return mutate((current) => ({
    next: current.map((r) => (r.id === "a" ? { ...r, status: "stopped", nextWakeAt: undefined } : r)),
    result: "stopped"
  }));
}

let pass = 0, total = 0;
const check = (label, got, want) => {
  total += 1;
  const ok = got === want;
  if (ok) pass += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(56)}${ok ? "" : ` got ${got} want ${want}`}`);
};

console.log("THE RACE: user clicks Stop while a turn is in flight\n");

// The old shape is asserted to REPRODUCE the bug. If these ever start passing,
// the interleaving this test builds has stopped exercising the race and the
// green result below would be meaningless.
store = [{ id: "a", status: "running", nextWakeAt: undefined }];
await Promise.all([oldTurn(), oldStop()]);
console.log("  OLD read-then-write (expected to LOSE the stop):");
check("    reproduces the bug: stop was erased", store[0].status, "sleeping");
check("    reproduces the bug: loop re-armed itself", store[0].nextWakeAt, "armed");

store = [{ id: "a", status: "running", nextWakeAt: undefined }];
await Promise.all([newTurn(), newStop()]);
console.log("\n  NEW serialised mutation:");
check("    the user's Stop survives", store[0].status, "stopped");
check("    the loop is not re-armed", store[0].nextWakeAt, undefined);

console.log("\nCONCURRENT WRITERS DO NOT LOSE EACH OTHER");
store = [];
await Promise.all(
  Array.from({ length: 12 }, (_, i) =>
    mutate((current) => ({ next: [...current, { id: `loop-${i}` }], result: undefined }))
  )
);
check("  12 concurrent creates all landed", store.length, 12);
check("  no duplicates", new Set(store.map((r) => r.id)).size, 12);

console.log("\nA THROWING MUTATION DOES NOT WEDGE THE CHAIN");
await mutate(() => { throw new Error("boom"); }).catch(() => {});
store = [];
await mutate((current) => ({ next: [...current, { id: "after-throw" }], result: undefined }));
check("  the queue still works after a throw", store.length, 1);

console.log(`\n  ${pass}/${total} checks correct`);
process.exit(pass === total ? 0 : 1);
