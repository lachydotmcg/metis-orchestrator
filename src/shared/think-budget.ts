/** The think-token ceiling, and the promotion it triggers.
 *
 *  Depths guesses. `pickDepthRung` judges a turn once, sends it to the matching
 *  model, and never revisits — so a turn judged trivial and handed to a local 8B
 *  that turns out to be hard just produces a bad answer at the cheap tier, and
 *  nothing anywhere in the app notices. Every other correction mechanism in this
 *  repo (fallback chains, the critic loop, the loop judge) reacts to a FAILURE;
 *  routing had no failure signal at all.
 *
 *  This is the signal (docs/COMPETITIVE_SWEEP.md, shortlist item 3). Nous's data
 *  on Hermes 4 says the dominant failure of small local reasoning models is
 *  never stopping — they cut overlong AIME generations from 28.2% to 6.1% — so
 *  the moment a model blows its thinking budget is free information about
 *  difficulty, available BEFORE anyone pays for the answer. Metis is the only
 *  product with a ladder to promote onto.
 *
 *  The rule that makes this safe, and the reason it is not a flat cap:
 *  **thinking only counts while it is ALL the model has produced.** A model that
 *  has started writing its answer has finished deliberating, and killing it then
 *  throws away a real answer to punish a long preamble. The overrun that matters
 *  is the one where nothing is coming.
 *
 *  Pure so the offline suite can hold the rule still: the stream reader in
 *  main.ts owns the bytes, this owns the judgement.
 */

/** Thinking allowed on a rung before the turn is treated as misrouted.
 *
 *  1500 is deliberately generous — roughly a page and a half of reasoning. This
 *  is not a "keep it brief" cap; it is a "this model is not going to stop"
 *  detector, and a false positive costs a promotion to a model that did not need
 *  one. The failure it is aimed at runs to thousands of tokens. */
export const DEFAULT_THINK_TOKEN_CEILING = 1500;

/** Chars per token, matching estimateUsage in main.ts.
 *
 *  A stream gives characters, not tokens, and Ollama reports `eval_count` only
 *  when the generation ENDS — which is exactly what never happens in the case
 *  this exists to catch. So the budget is enforced on an estimate, and the
 *  estimate is the same one the usage ledger already uses rather than a second
 *  one that could disagree with it. */
export const THINK_CHARS_PER_TOKEN = 4;

export function thinkCeilingChars(ceilingTokens: number): number {
  if (!Number.isFinite(ceilingTokens) || ceilingTokens <= 0) return 0;
  return Math.ceil(ceilingTokens) * THINK_CHARS_PER_TOKEN;
}

/** Whether a stream should be cut short and its turn promoted.
 *
 *  `ceilingChars` of 0 means no ceiling — the feature is off, and off must be
 *  byte-identical to before it existed. */
export function shouldPromoteForThinking(state: { thoughtChars: number; outputChars: number; ceilingChars: number }): boolean {
  if (!state.ceilingChars) return false;
  // See the header: once an answer has started, the deliberation is over and
  // the turn is not misrouted, it is merely verbose.
  if (state.outputChars > 0) return false;
  return state.thoughtChars > state.ceilingChars;
}

/** The rung a blown budget promotes to, or null when there is nowhere to go.
 *
 *  The internal scale is 1 trivial, 2 standard, 3 deep — so promoting means
 *  going UP. (The node UI counts the other way, L1 hardest, which is why every
 *  user-facing string maps through `4 - depth`; getting this backwards would
 *  demote a struggling turn onto something cheaper.)
 *
 *  Null at 3 is a refusal, not an omission: a turn already on the deepest rung
 *  that cannot stop thinking has no better model to be handed to, and looping
 *  it back through the same one would double the bill to reproduce the same
 *  failure. */
export function promotedDepth(depth: 1 | 2 | 3): 1 | 2 | 3 | null {
  return depth === 1 ? 2 : depth === 2 ? 3 : null;
}

/** Thrown by the stream reader when a rung blows its thinking budget, so the
 *  caller can tell this apart from a user pressing Stop and from a provider
 *  falling over. Both of those mean "do not retry"; this one means "retry
 *  higher", and a shared error type would collapse the three. */
export class ThinkBudgetExceededError extends Error {
  readonly thoughtChars: number;
  constructor(thoughtChars: number) {
    super(`The model spent its whole thinking budget without starting an answer (${thoughtChars} characters of reasoning).`);
    this.name = "ThinkBudgetExceededError";
    this.thoughtChars = thoughtChars;
  }
}

export function isThinkBudgetError(error: unknown): error is ThinkBudgetExceededError {
  return error instanceof Error && error.name === "ThinkBudgetExceededError";
}
