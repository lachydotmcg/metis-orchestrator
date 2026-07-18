/** The built-in router (docs/DRILL_PLAN.md CORE.10).
 *
 *  WHY THIS EXISTS: decidePolicy shells out to the separate metis-policy CLI,
 *  resolved from env vars or SIBLING paths (../metis-policy/). electron-builder
 *  never bundles it, so on every machine that is not the developer's it is
 *  simply absent, and decidePolicy fell back to `sampleDecision` - a single
 *  hardcoded object that answers "qwen3:8b" for every prompt ever typed,
 *  whether or not that model is installed. The headline feature of the app
 *  therefore worked for exactly one person on Earth and was silently dead for
 *  everyone who installed it.
 *
 *  This module replaces that dead end with a real decision made in-process:
 *  it classifies the prompt, then picks from what is ACTUALLY AVAILABLE on
 *  this machine. It is deliberately simpler than the benchmark-driven CLI,
 *  which still wins whenever it is present. The contract is only that this is
 *  honest: a real classification, a real availability check, and evidence that
 *  says plainly which router produced the answer.
 *
 *  Availability lookups are INJECTED so this module stays free of any import
 *  edge back into main.ts. */

import type { RouteDecision, Route, TaskType } from "../shared/policy-contract.js";

export interface BuiltinRouterInputs {
  /** Ollama tags actually pulled on this machine, e.g. ["qwen3:8b"]. */
  installedLocalModels: string[];
  /** Cloud providers with a usable key, in the app's ProviderKey naming. */
  configuredCloudProviders: string[];
  /** The owner's stated preference, when onboarding captured one. */
  modelPreference?: "local" | "cloud" | "hybrid";
}

/** Keyword signals per task type. Ordered by specificity: the first type to
 *  match wins, so "write a react component" lands on frontend_design rather
 *  than the broader coding bucket. Deliberately boring and inspectable. */
const TASK_SIGNALS: Array<{ type: TaskType; pattern: RegExp }> = [
  { type: "private_sensitive", pattern: /\b(private|confidential|secret|sensitive|do not send|keep this local|offline only)\b/i },
  { type: "frontend_design", pattern: /\b(css|tailwind|layout|landing page|front[- ]?end|frontend|ui|ux|design|styling|responsive|react component|html page)\b/i },
  { type: "coding", pattern: /\b(code|function|bug|refactor|typescript|javascript|python|api|class|method|compile|stack trace|error|test|regex|sql|script)\b/i },
  { type: "summarisation", pattern: /\b(summari[sz]e|tl;?dr|condense|shorten|key points|recap|digest)\b/i },
  { type: "long_context", pattern: /\b(whole (repo|codebase|document)|entire (file|project|book)|across (all|every) (file|document))\b/i }
];

/** Rough token estimate, matching the app's own 4-chars-per-token heuristic. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function classifyTaskType(prompt: string): { type: TaskType; match?: string; confidence: number } {
  for (const signal of TASK_SIGNALS) {
    const found = signal.pattern.exec(prompt);
    if (found) return { type: signal.type, match: found[0], confidence: 0.72 };
  }
  // Very long prompts are long-context regardless of vocabulary.
  if (estimateTokens(prompt) > 3000) return { type: "long_context", confidence: 0.6 };
  return { type: "general_chat", confidence: 0.55 };
}

/** Local models this router prefers per task, best first. Only ever used to
 *  ORDER what the machine already has - never to suggest an install. */
const LOCAL_PREFERENCES: Record<TaskType, string[]> = {
  coding: ["qwen3-coder", "qwen3:32b", "qwen3:14b", "qwen3:8b", "deepseek-r1", "qwen3:4b"],
  frontend_design: ["qwen3:32b", "qwen3:14b", "qwen3:8b", "gemma", "qwen3:4b"],
  summarisation: ["qwen3:8b", "qwen3:4b", "gemma", "qwen3:1.7b"],
  long_context: ["qwen3:32b", "qwen3:14b", "qwen3:8b"],
  private_sensitive: ["qwen3:8b", "qwen3:14b", "qwen3:4b", "qwen3:1.7b"],
  general_chat: ["qwen3:8b", "qwen3:4b", "gemma", "qwen3:1.7b"]
};

/** Cloud models per task, best first, keyed by the app's ProviderKey. */
const CLOUD_PREFERENCES: Record<TaskType, Array<{ provider: string; model: string }>> = {
  coding: [
    { provider: "anthropic", model: "claude-sonnet-5" },
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "openai", model: "gpt-5.6-terra" }
  ],
  frontend_design: [
    { provider: "anthropic", model: "claude-sonnet-5" },
    { provider: "openai", model: "gpt-5.6-terra" },
    { provider: "gemini", model: "gemini-3.1-pro" }
  ],
  summarisation: [
    { provider: "gemini", model: "gemini-3.5-flash" },
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001" }
  ],
  long_context: [
    { provider: "gemini", model: "gemini-3.1-pro" },
    { provider: "anthropic", model: "claude-sonnet-5" }
  ],
  private_sensitive: [],
  general_chat: [
    { provider: "deepseek", model: "deepseek-chat" },
    { provider: "gemini", model: "gemini-3.5-flash" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001" }
  ]
};

/** Picks the first preferred local model the machine ACTUALLY has, matching
 *  on tag prefix so "qwen3:8b" matches an installed "qwen3:8b-instruct-q4". */
function pickLocalModel(taskType: TaskType, installed: string[]): string | null {
  if (installed.length === 0) return null;
  for (const preferred of LOCAL_PREFERENCES[taskType]) {
    const hit = installed.find((tag) => tag.toLowerCase().startsWith(preferred.toLowerCase()));
    if (hit) return hit;
  }
  // Nothing preferred is installed, but something is: use it rather than
  // naming a model the user does not have. Honesty beats preference.
  return installed[0];
}

function pickCloudRoute(taskType: TaskType, configured: string[]): { provider: string; model: string } | null {
  for (const option of CLOUD_PREFERENCES[taskType]) {
    if (configured.includes(option.provider)) return option;
  }
  return null;
}

/** Builds a real RouteDecision in-process. Never throws: with nothing
 *  installed and nothing configured it still returns a well-formed decision
 *  whose availability is honest, so the caller can surface a useful error
 *  instead of pretending a route exists. */
export function builtinRouteDecision(prompt: string, promptHash: string, inputs: BuiltinRouterInputs): RouteDecision {
  const trimmed = prompt.trim();
  const classified = classifyTaskType(trimmed);
  const preference = inputs.modelPreference ?? "hybrid";

  const localTag = pickLocalModel(classified.type, inputs.installedLocalModels);
  const cloud = classified.type === "private_sensitive" ? null : pickCloudRoute(classified.type, inputs.configuredCloudProviders);

  const localOption: Route | null = localTag
    ? { kind: "local", runtime: "ollama", model: localTag, availability: "available" }
    : null;
  const cloudOption: Route | null = cloud
    ? { kind: "cloud", provider: cloud.provider, model: cloud.model, availability: "available" }
    : null;

  // Preference decides the ORDER; availability decides what is possible.
  // private_sensitive always stays local, whatever the preference says.
  //
  // HYBRID is the interesting case and the product's actual promise: easy
  // work stays local and free, hard work escalates to cloud. Sending every
  // task to the local model would make this a local-only default wearing a
  // router's clothes, which is what sampleDecision effectively was. So in
  // hybrid, the tasks where a frontier model measurably wins (writing code,
  // designing interfaces, reasoning over long context) prefer cloud when one
  // is configured, and everything conversational stays local.
  const CLOUD_FAVOURED: TaskType[] = ["coding", "frontend_design", "long_context"];
  const preferLocal =
    preference === "local" ||
    classified.type === "private_sensitive" ||
    (preference === "hybrid" && !CLOUD_FAVOURED.includes(classified.type));
  // preferLocal already folds in preference AND task type, so it alone
  // decides the order. (An earlier version fell through a ternary chain to
  // local-first whenever preference was not exactly "cloud", which silently
  // undid the hybrid escalation above.)
  const ordered = preferLocal ? [localOption, cloudOption] : [cloudOption, localOption];
  const available = ordered.filter((option): option is Route => option !== null);

  const selected: Route = available[0] ?? {
    kind: "none",
    availability: "not_configured",
    condition: "No local model is installed and no cloud provider is configured."
  };

  const reasonParts: string[] = [];
  if (selected.kind === "local") {
    reasonParts.push(`${selected.model} is installed locally and suits ${classified.type.replace(/_/g, " ")}`);
    if (classified.type === "private_sensitive") reasonParts.push("the prompt looks sensitive, so it stays on this machine");
    else if (preference === "local") reasonParts.push("your preference is local-first");
    else reasonParts.push("local inference is free");
  } else if (selected.kind === "cloud") {
    reasonParts.push(`${selected.provider} ${selected.model} is configured and suits ${classified.type.replace(/_/g, " ")}`);
    if (!localOption) reasonParts.push("no local model is installed yet");
  } else {
    reasonParts.push("nothing is available to route to yet: install a local model with Ollama, or add a provider key in Settings");
  }

  return {
    schema_version: "0.1.0",
    policy_version: "builtin-0.1.0",
    created_at: new Date().toISOString(),
    task_type: classified.type,
    prompt_profile: {
      estimated_tokens: estimateTokens(trimmed),
      raw_prompt_stored: false,
      prompt_sha256: promptHash,
      signals: classified.match ? [{ kind: classified.type, match: classified.match }] : []
    },
    router_preset: preference === "local" ? "local_first" : "balanced",
    selected_route: selected,
    confidence: selected.kind === "none" ? 0.2 : classified.confidence,
    fallback_routes: available.slice(1),
    reason: `Built-in router: ${reasonParts.join(", ")}.`,
    evidence: [
      {
        id: `classification:${classified.type}`,
        source_type: "policy_rule",
        source: "builtin-router-0.1.0",
        metric: "task_type",
        value: classified.type,
        summary: classified.match
          ? `Prompt classified as ${classified.type} on the signal "${classified.match}".`
          : `Prompt classified as ${classified.type} with no specific signal.`
      },
      {
        id: "availability:local",
        source_type: "policy_rule",
        source: "builtin-router-0.1.0",
        metric: "installed_local_models",
        value: inputs.installedLocalModels.length,
        summary:
          inputs.installedLocalModels.length > 0
            ? `${inputs.installedLocalModels.length} local model(s) installed: ${inputs.installedLocalModels.slice(0, 6).join(", ")}.`
            : "No local models are installed."
      },
      {
        id: "availability:cloud",
        source_type: "policy_rule",
        source: "builtin-router-0.1.0",
        metric: "configured_cloud_providers",
        value: inputs.configuredCloudProviders.length,
        summary:
          inputs.configuredCloudProviders.length > 0
            ? `Configured cloud providers: ${inputs.configuredCloudProviders.join(", ")}.`
            : "No cloud providers are configured."
      }
    ],
    scores: [],
    warnings:
      selected.kind === "none"
        ? ["No route is available. Install a model with Ollama, or add a provider API key in Settings."]
        : [],
    reproducibility: {
      ruleset_version: "builtin-0.1.0",
      deterministic: true,
      profile_id: "builtin"
    }
  };
}
