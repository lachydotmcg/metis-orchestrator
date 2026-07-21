/** +added/-removed counts for a file overwrite (Lachy: the old counting called
 *  EVERY overwrite "+N -N" — whole old file removed, whole new file added —
 *  so a one-line tweak to a 189-line file displayed as +189 -189). Trims the
 *  common prefix and suffix of the two line lists and counts only the middle
 *  that actually differs. Not a minimal LCS diff (a change interleaved with
 *  unchanged lines counts the span between them), but it is exact for the
 *  common case of localized edits, never undercounts, and costs O(n) on files
 *  a real diff would be too heavy to run on every write.
 *
 *  Lives in shared/ (not main.ts) so the offline suites can import the REAL
 *  function from the build without pulling in Electron's side effects. */
export function lineDiffCounts(previous: string, next: string): { addedLines: number; removedLines: number } {
  const before = previous.length ? previous.split(/\r?\n/) : [];
  const after = next.length ? next.split(/\r?\n/) : [];
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { addedLines: after.length - prefix - suffix, removedLines: before.length - prefix - suffix };
}
