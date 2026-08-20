/** Refusing a generated write that looks like a truncated file.
 *
 *  The question that produced this: would you point Metis at the Metis repo?
 *
 *  The honest answer was no, and not for a vague reason. The orchestration
 *  build pipeline asks models for COMPLETE files ("Return COMPLETE files, not
 *  snippets" is in the front-end stage prompt verbatim), and
 *  `writeGeneratedFileSet` overwrites whole files unconditionally. That pairing
 *  is correct for the greenfield folders the pipeline was built for, where
 *  every file is one the model just authored. Point it at a real codebase and
 *  the same pairing is a shredder: this repo's `main.ts` is 742 KB and
 *  `App.tsx` is 874 KB, and a model asked to return either one complete will
 *  return something plausible, well-formed, and a tenth of the length.
 *
 *  The snapshot makes that recoverable, which is not the same as safe. The
 *  `lastProjectSnapshot` key holds ONE slot, so a five-turn loop leaves four of
 *  its backups unnameable from the revert control — they exist on disk and
 *  nothing in the UI can point at them.
 *
 *  Hence a guard rather than a warning. The failure mode being prevented is a
 *  file coming back short, and the only reliable signal available before the
 *  write is that it IS short.
 *
 *  The thresholds are deliberately loose, because a guard that fires on
 *  ordinary edits gets switched off:
 *
 *  - Files under 2 KB are never guarded. Small files legitimately change size
 *    dramatically, and a truncated 1 KB file is a minute of work to redo.
 *  - Above that, a write is refused only if it keeps less than HALF. Removing a
 *    function, deleting a class, cutting a section — all normal edits — keep far
 *    more than half. Returning a tenth does not happen by accident.
 *  - New files pass at any size. There is nothing to lose.
 *
 *  A genuine large deletion is refused too, and that is the intended trade:
 *  doing it by hand costs a minute, and not doing it by hand costs the file.
 */

/** Below this, a file is not worth guarding: small files legitimately swing in
 *  size, and re-doing a truncated one is trivial. */
export const GENERATED_WRITE_MIN_GUARDED_BYTES = 2048;

/** A guarded write must keep at least this fraction of what is already there.
 *  Half is loose on purpose — normal edits keep far more, and a truncation
 *  keeps far less, so the gap between them is wide enough that the exact number
 *  does not have to be clever. */
export const GENERATED_WRITE_MIN_KEPT_RATIO = 0.5;

/** True when overwriting a file of `existingBytes` with `incomingBytes` looks
 *  like truncation rather than an edit.
 *
 *  Pure and byte-based rather than line- or AST-based on purpose: it has to be
 *  right for every file type the pipeline can emit, including ones with no
 *  parser available, and "much shorter than it was" is the one signal that
 *  means the same thing in all of them. */
export function generatedWriteWouldTruncate(existingBytes: number, incomingBytes: number): boolean {
  if (existingBytes < GENERATED_WRITE_MIN_GUARDED_BYTES) return false;
  return incomingBytes < existingBytes * GENERATED_WRITE_MIN_KEPT_RATIO;
}
