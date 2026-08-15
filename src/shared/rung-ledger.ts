/** Rolling the usage ledger up by Depths rung (docs/COMPETITIVE_SWEEP.md #4).
 *
 *  What this is: a record of which rung actually served each run, and what that
 *  cost. Nothing more.
 *
 *  **What it deliberately is NOT: a savings claim.** The sweep proposed a
 *  counterfactual — "you saved $X versus a frontier model" — then corrected
 *  itself, noting a frontier model would not take the same number of turns, and
 *  suggested labelling it "same turns at frontier pricing" instead.
 *
 *  Checking that correction, it does not survive either. Two things differ when
 *  a different model answers, not one: the number of turns AND the tokens per
 *  turn. Pricing this run's exact token counts at another model's rate answers
 *  "what would you have paid if a different model behaved identically to this
 *  one", which is a question about nothing. And the deeper problem is not
 *  arithmetic at all — the cheap rung's answer may simply have been worse, so
 *  the money not spent is not necessarily money saved.
 *
 *  So there is no counterfactual here, and the absence is the feature. "L3
 *  served 47 turns for nothing, L1 served 6 for $2.40" is a fact the owner can
 *  act on. "You saved $18" is a number that cannot be defended in the one
 *  conversation where it matters.
 *
 *  Pure, so the offline suite exercises the real arithmetic.
 */

/** One rung's share of the ledger. `depth` is null for runs recorded before
 *  the rung was captured, and for every run with Depths off — which is the
 *  default, so this bucket is normally the largest one and must never be
 *  quietly merged into a rung that did not serve those turns. */
export interface RungRollup {
  depth: 1 | 2 | 3 | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** True when any contributing row had estimated token counts, so the total
   *  cannot be presented as exact. */
  estimated: boolean;
  /** Runs on this rung that got here by being promoted off a cheaper one. The
   *  only number in the ledger that counts routing being WRONG, which is why it
   *  is worth carrying rather than folding into `runs`. */
  promotedIn: number;
  /** Runs that started on this rung and were promoted away from it. */
  promotedOut: number;
}

export interface RungLedgerRow {
  depth?: 1 | 2 | 3;
  depthPromotedFrom?: 1 | 2 | 3;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
}

const DEPTHS: ReadonlyArray<1 | 2 | 3> = [1, 2, 3];

function isDepth(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

/** Rolls ledger rows up by the rung that SERVED them.
 *
 *  A promoted run counts its tokens against the rung that answered, because
 *  that is where the money went — and separately increments `promotedOut` on
 *  the rung it abandoned, so the ladder's error rate is visible without
 *  double-counting the spend.
 *
 *  Rungs with no runs are dropped: an empty row invites the reader to wonder
 *  what happened on it, and the answer is nothing. The null bucket survives
 *  whenever it has runs, because "not recorded" is a real answer. */
export function rollUpByRung(rows: readonly RungLedgerRow[]): RungRollup[] {
  const empty = (depth: 1 | 2 | 3 | null): RungRollup => ({
    depth,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: false,
    promotedIn: 0,
    promotedOut: 0
  });
  const buckets = new Map<1 | 2 | 3 | null, RungRollup>();
  for (const depth of [...DEPTHS, null] as Array<1 | 2 | 3 | null>) buckets.set(depth, empty(depth));

  for (const row of rows ?? []) {
    const served = isDepth(row?.depth) ? row.depth : null;
    const bucket = buckets.get(served)!;
    bucket.runs += 1;
    bucket.inputTokens += Number.isFinite(row?.inputTokens) ? Number(row.inputTokens) : 0;
    bucket.outputTokens += Number.isFinite(row?.outputTokens) ? Number(row.outputTokens) : 0;
    if (row?.estimated) bucket.estimated = true;
    // A promotion is only meaningful when BOTH ends are known and differ; a
    // stored record from an older build could carry one without the other.
    if (isDepth(row?.depthPromotedFrom) && served !== null && row.depthPromotedFrom !== served) {
      bucket.promotedIn += 1;
      buckets.get(row.depthPromotedFrom)!.promotedOut += 1;
    }
  }

  return [...buckets.values()].filter((bucket) => bucket.runs > 0 || bucket.promotedOut > 0);
}

/** How a rung is named to the owner.
 *
 *  The user-facing scale is REVERSED from the internal one: internally 3 is
 *  deepest, but the node UI counts L1 as the hardest tier so future L4/L5 can
 *  extend the cheap end. Every label in the app maps through `4 - depth`, and
 *  getting it backwards here would report the cheap rung's spend as the
 *  expensive one's. */
export function rungLabel(depth: 1 | 2 | 3 | null): string {
  if (depth === null) return "Not recorded";
  return `L${4 - depth}`;
}

/** The one-line description under the rung table, which has to survive the
 *  question "so what did Depths save me". It answers by refusing the premise:
 *  this is what was spent where, and what a different model would have cost is
 *  not knowable from it. */
export const RUNG_LEDGER_NOTE =
  "What each rung actually served and spent. There is no “you saved” figure here on purpose: a different model would not have taken the same turns or produced the same tokens, and the cheaper answer is not automatically the equal one.";
