// Line-diff counts for the file-edit display. Imports the REAL lineDiffCounts
// from the build.
//
// The bug it exists to prevent: writeTextArtifact used to count the WHOLE old
// file as removed and the WHOLE new file as added on every overwrite, so a
// one-line tweak to a 189-line file displayed as "+189 -189" — every edit in a
// session showed the same pair of numbers, and none of them meant anything.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, summary } from "../harness.mjs";

const { lineDiffCounts } = await fromBuild("shared/line-diff.js");

const lines = (n, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n");

section("The +189 -189 bug: an overwrite is not a rewrite");
{
  // Change one line in the middle of a 189-line file.
  const before = lines(189);
  const after = before.replace("line 95", "line 95 edited");
  check("one edited line counts as +1 -1", lineDiffCounts(before, after), { addedLines: 1, removedLines: 1 });
}
check("identical content counts as +0 -0", lineDiffCounts(lines(50), lines(50)), { addedLines: 0, removedLines: 0 });

section("Pure additions and removals");
check("new file: everything added", lineDiffCounts("", "a\nb\nc"), { addedLines: 3, removedLines: 0 });
check("emptied file: everything removed", lineDiffCounts("a\nb\nc", ""), { addedLines: 0, removedLines: 3 });
check("append at the end", lineDiffCounts("a\nb", "a\nb\nc\nd"), { addedLines: 2, removedLines: 0 });
check("prepend at the start", lineDiffCounts("a\nb", "x\na\nb"), { addedLines: 1, removedLines: 0 });
check("insert in the middle", lineDiffCounts("a\nb\nc", "a\nnew\nb\nc"), { addedLines: 1, removedLines: 0 });
check("delete from the middle", lineDiffCounts("a\nb\nc", "a\nc"), { addedLines: 0, removedLines: 1 });

section("Edge shapes");
check("both empty", lineDiffCounts("", ""), { addedLines: 0, removedLines: 0 });
check("CRLF vs LF line endings compare by content", lineDiffCounts("a\r\nb\r\nc", "a\nb\nc"), { addedLines: 0, removedLines: 0 });
check("full rewrite still counts everything", lineDiffCounts("a\nb", "x\ny\nz"), { addedLines: 3, removedLines: 2 });
// Prefix/suffix must not double-count overlapping lines: "a" is both the
// common prefix and (as content) the last line — the windows must not overlap.
check("repeated boundary lines don't double-count", lineDiffCounts("a\na", "a"), { addedLines: 0, removedLines: 1 });

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
