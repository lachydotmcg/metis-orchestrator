/** Per-node depth rung selection (roadmap "Per-node Depths").
 *
 *  Pure selection + validation only, extracted from main.ts's stageDepthRef so
 *  the offline suites can exercise the REAL rule from the build, not a copy.
 *  main.ts keeps the parts that need its own machinery (localStageRef,
 *  resolveGraphStageModel) and maps the outcome onto a StageModelRef.
 *
 *  The rules, mirroring depthRouteFor rung for rung:
 *   - "router" → the local router model handles this level itself.
 *   - a valid {provider, model} pick → that model leads the stage's chain.
 *   - unpinned L1 → the local model (the free tier the node UI promises).
 *   - unpinned L2/L3 → the stage's normal chain stands. (For L3 the renderer
 *     already projects the node's primary as the default, so an absent deep
 *     rung only happens when nothing was mappable.)
 *  Every value is re-validated because graphPipeline is a plain JSON store
 *  key anyone could have written. */

export type DepthRungPick = { provider: string; model: string } | "router";

export interface DepthStack {
  shallow?: DepthRungPick;
  standard?: DepthRungPick;
  deep?: DepthRungPick;
}

export type DepthRungOutcome =
  | { kind: "model"; provider: string; model: string }
  | { kind: "local" }
  | { kind: "chain" };

export function pickDepthRung(
  stack: DepthStack | undefined,
  depth: 1 | 2 | 3,
  isKnownProvider: (provider: string) => boolean
): DepthRungOutcome {
  if (!stack) return { kind: "chain" };
  const choice = depth === 3 ? stack.deep : depth === 2 ? stack.standard : stack.shallow;
  if (choice === "router") return { kind: "local" };
  if (
    choice &&
    typeof choice === "object" &&
    typeof choice.provider === "string" &&
    isKnownProvider(choice.provider) &&
    typeof choice.model === "string" &&
    choice.model.trim().length > 0
  ) {
    return { kind: "model", provider: choice.provider, model: choice.model };
  }
  // The L1 default is the free local tier; L2/L3 unpinned leave the chain.
  return depth === 1 ? { kind: "local" } : { kind: "chain" };
}
