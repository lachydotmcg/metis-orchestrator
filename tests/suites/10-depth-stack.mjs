// Per-node depth rung selection (roadmap "Per-node Depths"). Imports the REAL
// pickDepthRung from the build — the same function main.ts's stageDepthRef
// adapts onto each pipeline stage's chain.
//
// The properties that cost money or correctness if they break:
//  - a garbage graphPipeline store value must never become a routed model,
//  - an unpinned L1 must stay the free local tier the node UI promises,
//  - an unpinned L2/L3 must leave the stage's normal chain alone,
//  - "router" must mean the local model, at every level.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, summary } from "../harness.mjs";

const { pickDepthRung } = await fromBuild("shared/depth-stack.js");

const KNOWN = new Set(["ollama", "anthropic", "openai", "deepseek"]);
const known = (provider) => KNOWN.has(provider);

const stack = {
  shallow: { provider: "ollama", model: "qwen3:8b" },
  standard: { provider: "deepseek", model: "deepseek-chat" },
  deep: { provider: "anthropic", model: "claude-sonnet-4-6" }
};

section("A full stack routes each depth to its own rung");
check("depth 1 → shallow", pickDepthRung(stack, 1, known), { kind: "model", provider: "ollama", model: "qwen3:8b" });
check("depth 2 → standard", pickDepthRung(stack, 2, known), { kind: "model", provider: "deepseek", model: "deepseek-chat" });
check("depth 3 → deep", pickDepthRung(stack, 3, known), { kind: "model", provider: "anthropic", model: "claude-sonnet-4-6" });

section("Unpinned rungs fall back the way the node UI promises");
check("no stack at all → chain", pickDepthRung(undefined, 3, known), { kind: "chain" });
check("empty stack, depth 1 → local (free tier)", pickDepthRung({}, 1, known), { kind: "local" });
check("empty stack, depth 2 → chain", pickDepthRung({}, 2, known), { kind: "chain" });
check("empty stack, depth 3 → chain", pickDepthRung({}, 3, known), { kind: "chain" });

section("'router' means the local model handles the level itself");
check("router at L1", pickDepthRung({ shallow: "router" }, 1, known), { kind: "local" });
check("router at L2", pickDepthRung({ standard: "router" }, 2, known), { kind: "local" });
check("router at L3", pickDepthRung({ deep: "router" }, 3, known), { kind: "local" });

section("Garbage store data never becomes a routed model");
check("unknown provider, depth 3 → chain", pickDepthRung({ deep: { provider: "notaprovider", model: "x" } }, 3, known), { kind: "chain" });
check("unknown provider, depth 1 → local", pickDepthRung({ shallow: { provider: "notaprovider", model: "x" } }, 1, known), { kind: "local" });
check("empty model string → chain", pickDepthRung({ deep: { provider: "anthropic", model: "   " } }, 3, known), { kind: "chain" });
check("missing model field → chain", pickDepthRung({ deep: { provider: "anthropic" } }, 3, known), { kind: "chain" });
check("non-object rung → chain", pickDepthRung({ deep: 42 }, 3, known), { kind: "chain" });
check("null rung → chain", pickDepthRung({ deep: null }, 3, known), { kind: "chain" });

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
