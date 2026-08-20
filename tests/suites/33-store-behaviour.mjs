// The store and the audit log, against a real temp directory.
//
// Every persisted thing in Metis goes through these nine functions — the
// profile, the provider accounts, the loops, the usage ledger, the permission
// grants. Nothing tested them until the store was carved out of main.ts
// (docs/STRUCTURAL_DEBT.md item 1) and given the userData directory as
// configuration instead of calling `app.getPath` for it.
//
// That injection is the only reason this file can exist. A store that fetched
// its own path from electron could not be pointed anywhere, so its failure
// modes — a corrupt file, a hostile key, a malformed log line — could only be
// exercised by breaking a real installation.
//
// Offline: no provider is called, no electron API is touched, no API key is
// read. Writes go to a temp directory that is removed at the end.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const store = await fromBuild("electron/store.js");

const root = mkdtempSync(join(tmpdir(), "metis-store-test-"));
store.configureStore(root);
const storeDir = join(root, "metis-store");

section("A key is a filename, and the pattern is the containment");
{
  // storePath builds a path from caller-supplied text, so the pattern is the
  // only thing between a key and the rest of the disk. Asserted as REFUSALS
  // rather than by checking the resulting path, because a traversal that gets
  // as far as producing a path has already lost.
  for (const hostile of ["../escape", "a/b", "a\\b", "..", "with space", "dot.key", "", "key$", "key:name"]) {
    let threw = false;
    try { store.storePath(hostile); } catch { threw = true; }
    ok(`"${hostile}" is refused`, threw);
  }
  // And the shapes real keys actually take still work.
  for (const fine of ["profile", "account-secrets", "lastProjectSnapshot", "usageLedger", "a_b-C9"]) {
    ok(`"${fine}" is accepted`, store.storePath(fine).endsWith(`${fine}.json`));
  }
  ok("the path lands under the configured directory", store.storePath("profile").startsWith(storeDir));
}

section("Round-tripping a value");
{
  await store.writeStoreValue("roundtrip", { a: 1, b: ["x", null], c: true });
  const read = await store.readStoreValue("roundtrip", null);
  check("what went in comes out", read, { a: 1, b: ["x", null], c: true });

  // The directory is created on demand — a fresh install has no metis-store/.
  ok("writing created the store directory", existsSync(storeDir));
}

section("A missing key returns the fallback, whatever the fallback is");
{
  check("an object fallback", await store.readStoreValue("never-written", { d: 1 }), { d: 1 });
  check("an array fallback", await store.readStoreValue("never-written-2", []), []);
  check("a null fallback", await store.readStoreValue("never-written-3", null), null);
  check("and a primitive one", await store.readStoreValue("never-written-4", 7), 7);
}

section("A corrupt file reads as unset rather than taking the caller down");
{
  // The case this exists for: a crash or a full disk mid-write leaves a
  // half-written file. Every consumer of the store treats a missing key as
  // "not set yet", and a truncated one has to mean the same thing or the app
  // fails to start on a file nobody can see.
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "halfwritten.json"), '{"a": 1, "b": [1, 2', "utf8");
  check("truncated JSON falls back", await store.readStoreValue("halfwritten", { safe: true }), { safe: true });

  writeFileSync(join(storeDir, "empty.json"), "", "utf8");
  check("an empty file falls back", await store.readStoreValue("empty", { safe: true }), { safe: true });

  writeFileSync(join(storeDir, "garbage.json"), "not json at all", "utf8");
  check("outright garbage falls back", await store.readStoreValue("garbage", { safe: true }), { safe: true });

  // THE GAP, asserted so it is a known property rather than a surprise. The
  // parse is a cast: a file that is VALID JSON of the wrong shape comes back
  // as-is, and a caller that immediately maps over it throws. Recorded in
  // docs/LIMITATIONS.md; four functions in main.ts do exactly that.
  writeFileSync(join(storeDir, "wrongshape.json"), "null", "utf8");
  const wrong = await store.readStoreValue("wrongshape", []);
  ok("valid-but-wrong JSON is NOT caught by the fallback", wrong === null);
}

section("Overwriting replaces rather than merges");
{
  await store.writeStoreValue("overwrite", { a: 1, b: 2 });
  await store.writeStoreValue("overwrite", { a: 9 });
  check("the old keys are gone", await store.readStoreValue("overwrite", null), { a: 9 });
}

section("The audit log appends, and survives a bad line");
{
  const first = await store.appendAudit("info", "test.one", "first event");
  ok("an event comes back with an id", typeof first.id === "string" && first.id.length > 0);
  ok("and a timestamp that parses", !Number.isNaN(Date.parse(first.createdAt)));
  check("the level is kept", first.level, "info");

  await store.appendAudit("warning", "test.two", "second event", { extra: 1 });
  const listed = await store.listAudit(10);
  check("both are there", listed.length, 2);
  // Newest first, because every consumer shows a tail.
  check("newest first", listed[0].kind, "test.two");
  check("metadata survives the round trip", listed[0].metadata, { extra: 1 });

  const limited = await store.listAudit(1);
  check("the limit takes the NEWEST, not the oldest", limited.map((e) => e.kind), ["test.two"]);
}

section("Audit reads never throw, and say so by returning nothing");
{
  // Documented behaviour worth pinning: one malformed line collapses the WHOLE
  // call to [], because the outer catch covers the .map. A truncated log reads
  // as empty rather than as a lie about what happened — but "empty" and "two
  // good lines and one bad one" are then indistinguishable, which is the thing
  // to know when a log looks emptier than it should.
  writeFileSync(join(storeDir, "audit-log.jsonl"), '{"id":"a","kind":"good"}\nnot json\n', "utf8");
  check("a malformed line empties the list rather than throwing", await store.listAudit(10), []);

  rmSync(join(storeDir, "audit-log.jsonl"));
  check("and a missing log is empty too", await store.listAudit(10), []);
}

section("exists() answers without throwing");
{
  ok("a real file", (await store.exists(join(storeDir, "roundtrip.json"))) === true);
  ok("a missing one", (await store.exists(join(storeDir, "nope.json"))) === false);
  ok("and a nonsense path", (await store.exists(join(root, "no", "such", "dir", "x"))) === false);
}

section("dataPath composes under the configured root");
{
  ok("one part", store.dataPath("audit-log.jsonl").startsWith(storeDir));
  ok("several", store.dataPath("knowledge", "abc.json").startsWith(storeDir));
  // Unlike storePath, dataPath does NOT validate. `join` normalises the `..`
  // away, so the result does not merely LOOK wrong — it genuinely lands outside
  // the store directory. Safe today because every caller passes a literal
  // ("audit-log.jsonl", "snapshots", "knowledge"), and pinned here so that the
  // day one of them takes a caller-supplied string, this line is the reminder
  // that storePath's guard has no equivalent on this side.
  const escaped = store.dataPath("..", "escape");
  ok("dataPath is unvalidated and would escape the store directory", !escaped.startsWith(storeDir));
  ok("which is only safe because every caller passes a literal", escaped.startsWith(root));
}

rmSync(root, { recursive: true, force: true });

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
