export type TaskType =
  | "summarisation"
  | "coding"
  | "frontend_design"
  | "long_context"
  | "private_sensitive"
  | "general_chat";

export type RouteKind = "local" | "cloud" | "router" | "manual" | "none";

export type RouterPreset =
  | "balanced"
  | "local_first"
  | "best_quality"
  | "cheapest"
  | "private";

export interface EvidenceCitation {
  id: string;
  source_type: "benchmark_payload" | "provider_account" | "user_preference" | "policy_rule";
  source: string;
  metric?: string;
  value?: string | number | boolean;
  unit?: string;
  summary: string;
}

export interface Route {
  kind: RouteKind;
  model?: string;
  provider?: string;
  runtime?: string;
  preset?: RouterPreset;
  availability?: "available" | "not_configured" | "rate_limited" | "quota_exhausted" | "unavailable";
  condition?: string;
}

export interface RouteScore {
  route: Route;
  total: number;
  components: {
    quality: number;
    speed: number;
    cost: number;
    privacy: number;
    availability: number;
    risk_penalty: number;
    preference_bonus: number;
  };
  evidence: EvidenceCitation[];
  warnings: string[];
}

export interface PromptSignal {
  kind: string;
  match: string;
}

export interface RouteDecision {
  schema_version: string;
  policy_version: string;
  created_at: string;
  task_type: TaskType;
  prompt_profile: {
    estimated_tokens: number;
    signals: PromptSignal[];
    raw_prompt_stored: false;
    prompt_sha256: string;
  };
  router_preset: RouterPreset;
  selected_route: Route;
  confidence: number;
  fallback_routes: Route[];
  reason: string;
  evidence: EvidenceCitation[];
  scores: RouteScore[];
  warnings: string[];
  reproducibility: {
    ruleset_version: string;
    deterministic: true;
    profile_id: string;
  };
}
