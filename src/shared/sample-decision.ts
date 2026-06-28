import type { RouteDecision } from "./policy-contract.js";

export const sampleDecision: RouteDecision = {
  schema_version: "0.1.0",
  policy_version: "0.1.0",
  created_at: "2026-06-28T00:00:00.000Z",
  task_type: "summarisation",
  prompt_profile: {
    estimated_tokens: 18,
    raw_prompt_stored: false,
    prompt_sha256: "sample",
    signals: [{ kind: "summarisation", match: "Summarise" }]
  },
  router_preset: "balanced",
  selected_route: {
    kind: "local",
    runtime: "ollama",
    model: "qwen3:8b",
    availability: "available"
  },
  confidence: 0.87,
  fallback_routes: [
    {
      kind: "cloud",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      availability: "not_configured",
      condition: "Configure this provider before use."
    }
  ],
  reason:
    "local / ollama / qwen3:8b is selected for summarisation because it has strong quality evidence, acceptable measured speed, low configured cost pressure, local privacy. The decision is deterministic and based on the profile evidence plus the balanced preset.",
  evidence: [
    {
      id: "classification:summarisation",
      source_type: "policy_rule",
      source: "ruleset-0.1.0",
      metric: "task_type",
      value: "summarisation",
      summary: "Prompt classified as summarisation with confidence 0.78."
    },
    {
      id: "preference:balanced",
      source_type: "user_preference",
      source: "PolicyProfile.user_preferences",
      metric: "router_preset",
      value: "balanced",
      summary: "Router preset is balanced."
    },
    {
      id: "benchmark:qwen3:8b:summarisation",
      source_type: "benchmark_payload",
      source: "Metis Benchmark leaderboard payload",
      metric: "category_mean.summarisation",
      value: 0.93,
      summary: "qwen3:8b summarisation category mean 0.93."
    },
    {
      id: "benchmark:qwen3:8b:decode",
      source_type: "benchmark_payload",
      source: "Metis Benchmark leaderboard payload",
      metric: "mean_decode_tps",
      value: 38.1,
      unit: "tok/s",
      summary: "qwen3:8b mean decode speed 38.10 tok/s on this hardware."
    }
  ],
  scores: [
    {
      route: {
        kind: "local",
        runtime: "ollama",
        model: "qwen3:8b",
        availability: "available"
      },
      total: 0.905,
      components: {
        quality: 0.93,
        speed: 0.76,
        cost: 0.86,
        privacy: 1,
        availability: 1,
        risk_penalty: 0,
        preference_bonus: 0
      },
      evidence: [],
      warnings: []
    },
    {
      route: {
        kind: "cloud",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        availability: "not_configured"
      },
      total: 0.71,
      components: {
        quality: 0.96,
        speed: 0.65,
        cost: 0.28,
        privacy: 0.32,
        availability: 1,
        risk_penalty: 0,
        preference_bonus: 0
      },
      evidence: [],
      warnings: []
    }
  ],
  warnings: [],
  reproducibility: {
    ruleset_version: "ruleset-0.1.0",
    deterministic: true,
    profile_id: "sample-profile"
  }
};
