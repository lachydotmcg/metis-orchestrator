// The truncation guard, and the question that produced it.
//
// "Would you run Metis on the Metis repository?" The answer was no, for a
// reason the code states plainly once you line two facts up: the build pipeline
// asks models for COMPLETE files ("Return COMPLETE files, not snippets" is in
// the front-end stage prompt verbatim), and writeGeneratedFileSet overwrites
// whole files unconditionally. Correct for the greenfield folders it was built
// for. On a real codebase it is a shredder — this repo's own main.ts is 742 KB,
// and a model asked to return it complete returns something plausible,
// well-formed, and a tenth of the length.
//
// The snapshot makes that recoverable, which is not the same as safe: the
// lastProjectSnapshot key holds ONE slot, so a five-turn loop leaves four of its
// backups unnameable from the revert control.
//
// This suite pins the guard AND the two facts that make it necessary, so that
// if someone later softens the "COMPLETE files" prompt into a diff-based one,
// or the write stops being a whole-file overwrite, the reason this exists is
// still readable rather than folklore.
//
// Offline: no provider is called, nothing is written, no API key is read.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const {
  generatedWriteWouldTruncate,
  GENERATED_WRITE_MIN_GUARDED_BYTES,
  GENERATED_WRITE_MIN_KEPT_RATIO
} = await fromBuild("shared/write-guard.js");

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const main = read("src", "electron", "main.ts");

section("Small files are never guarded");
{
  // A truncated 1 KB file is a minute of work to redo, and small files
  // legitimately swing in size. A guard that fires on those gets switched off.
  ok("an empty file can be replaced by anything", !generatedWriteWouldTruncate(0, 0));
  ok("a tiny file can shrink to nothing", !generatedWriteWouldTruncate(500, 0));
  ok("and just under the floor is still free", !generatedWriteWouldTruncate(GENERATED_WRITE_MIN_GUARDED_BYTES - 1, 0));
  check("the floor is 2 KB", GENERATED_WRITE_MIN_GUARDED_BYTES, 2048);
}

section("Above the floor, keeping less than half is refused");
{
  const floor = GENERATED_WRITE_MIN_GUARDED_BYTES;
  ok("keeping everything is fine", !generatedWriteWouldTruncate(100_000, 100_000));
  ok("growing is fine", !generatedWriteWouldTruncate(100_000, 250_000));
  // Normal edits — deleting a function, cutting a section — keep far more than
  // half. This is the band that must stay open or the guard is useless.
  ok("deleting a quarter is fine", !generatedWriteWouldTruncate(100_000, 75_000));
  ok("deleting a third is fine", !generatedWriteWouldTruncate(100_000, 66_000));
  ok("exactly half is fine", !generatedWriteWouldTruncate(100_000, 50_000));
  ok("just under half is refused", generatedWriteWouldTruncate(100_000, 49_999));
  ok("a tenth is refused", generatedWriteWouldTruncate(100_000, 10_000));
  ok("and emptying a large file is refused", generatedWriteWouldTruncate(100_000, 0));
  check("the ratio is half", GENERATED_WRITE_MIN_KEPT_RATIO, 0.5);
  ok("the floor itself is guarded", generatedWriteWouldTruncate(floor, 0));
}

section("The case that motivated it, using this repo's real files");
{
  // Not invented numbers: stat the actual files. If main.ts is ever split up
  // and stops being enormous, this reads as a passing test rather than a
  // failing one, which is correct — the hazard would genuinely be smaller.
  const mainBytes = statSync(join(process.cwd(), "src", "electron", "main.ts")).size;
  const appBytes = statSync(join(process.cwd(), "src", "renderer", "ui", "App.tsx")).size;
  ok(`main.ts is ${Math.round(mainBytes / 1024)} KB, well past the floor`, mainBytes > GENERATED_WRITE_MIN_GUARDED_BYTES);
  ok(`App.tsx is ${Math.round(appBytes / 1024)} KB, well past the floor`, appBytes > GENERATED_WRITE_MIN_GUARDED_BYTES);
  // A model returning "a complete main.ts" realistically emits tens of KB, not
  // 742. That is the exact write this guard exists to stop.
  ok("a 40 KB 'complete' main.ts is refused", generatedWriteWouldTruncate(mainBytes, 40_000));
  ok("a 40 KB 'complete' App.tsx is refused", generatedWriteWouldTruncate(appBytes, 40_000));
  // And an honest large edit to the same file still goes through.
  ok("a real edit to main.ts still writes", !generatedWriteWouldTruncate(mainBytes, mainBytes - 5_000));
}

section("The guard is wired where every generated write funnels through");
{
  const fn = /async function writeGeneratedFileSet[\s\S]*?\n}/.exec(main);
  ok("writeGeneratedFileSet is found", Boolean(fn));
  ok("it consults the guard", /generatedWriteWouldTruncate\(/.test(fn[0]));
  // BEFORE the snapshot and before any write: a refusal that happens after a
  // partial write is not a refusal.
  ok(
    "and it refuses before taking the snapshot, not after",
    fn[0].indexOf("generatedWriteWouldTruncate") < fn[0].indexOf("snapshotBeforeWrite")
  );
  ok(
    "and before writing anything",
    fn[0].indexOf("generatedWriteWouldTruncate") < fn[0].indexOf("writeTextArtifact")
  );
  ok("refusing throws rather than skipping the file", /throw new Error\([\s\S]{0,400}Nothing was written/.test(fn[0]));
  ok("the message names the file and both sizes", /KB on disk, \$\{Math\.round\(incoming \/ 1024\)\} KB returned/.test(fn[0]));
  ok("and it leaves an audit line", /project\.write\.truncation/.test(fn[0]));
}

section("The two facts that make the guard necessary are still true");
{
  // If either of these changes, the guard's rationale changes with it — so they
  // are asserted rather than described. A pipeline that emitted diffs would not
  // need this; a write that merged rather than replaced would not either.
  ok(
    "the pipeline still asks models for COMPLETE files, not diffs",
    /Return COMPLETE files, not snippets/.test(main)
  );
  ok(
    "and the write is still a whole-file overwrite",
    /fileArtifacts\.push\(await writeTextArtifact\(full, file\.content\)\)/.test(main)
  );
  // The reason "recoverable" is not "safe": one slot.
  ok(
    "lastProjectSnapshot is still a single slot",
    /writeStoreValue\("lastProjectSnapshot", snapshot\)/.test(main)
  );
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
