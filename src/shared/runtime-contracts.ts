import type { RouteDecision, RouterPreset } from "./policy-contract.js";

export type ProviderKey =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "openrouter"
  | "nvidia"
  | "groq"
  | "ollama";

export type PermissionScope =
  | "filesystem.read"
  | "filesystem.write"
  | "network.provider"
  | "network.web"
  | "process.spawn"
  | "mcp.invoke"
  | "notifications.send";

export type AuditLevel = "info" | "warning" | "error";

export interface SecretStatus {
  provider: ProviderKey;
  hasSecret: boolean;
  storage: "safeStorage" | "plain-local" | "environment" | "none";
  updatedAt?: string;
}

export interface ProviderStatus {
  provider: ProviderKey;
  label: string;
  configured: boolean;
  status: "available" | "not_configured" | "unavailable" | "unknown";
  detail: string;
  defaultModel?: string;
}

export interface PermissionGrant {
  id: string;
  scope: PermissionScope;
  target: string;
  projectPath?: string;
  note?: string;
  grantedAt: string;
}

export interface PermissionRequest {
  scope: PermissionScope;
  target: string;
  projectPath?: string;
  note?: string;
}

/** Five-mode permission system (docs/FABLE_PLANS.md section 24), replacing the
 *  old restricted/standard/trusted three-level scheme:
 *  - "ask": every file write, command, and new network scope pauses for a verdict.
 *  - "edits": file writes auto-approved; commands + new scopes still ask.
 *  - "plan": read-only — the pipeline runs planning/analysis only, no writes/commands.
 *  - "auto": current trusted behavior — proceeds, asks only when there's no
 *    existing grant for that scope+path (default).
 *  - "bypass": no prompts at all, ever (scary-red UI treatment). */
export type PermissionMode = "ask" | "edits" | "plan" | "auto" | "bypass";

/** In-run permission prompt payload (docs/FABLE_PLANS.md section 24) — pauses
 *  the run mid-stream awaiting a verdict via `metis-permissions:respond`. */
export interface InRunPermissionRequest {
  id: string;
  scope: PermissionScope;
  target: string;
  detail: string;
}

export type PermissionVerdict = "allow" | "always" | "deny";

/** AskUserQuestion payload (docs/FABLE_PLANS.md section 24) — a stage model
 *  emitted `<ask_user>...</ask_user>` for a genuinely blocking decision. */
export interface UserQuestionRequest {
  id: string;
  text: string;
  options: string[];
}

export interface ProjectWorkspace {
  path: string;
  name: string;
  permissionId: string;
  selectedAt: string;
}

export interface ProjectWorkspaceSelectionResult {
  canceled: boolean;
  workspace?: ProjectWorkspace;
}

export interface ProjectWorkspaceResource {
  id: string;
  kind: "file" | "folder";
  path: string;
  name: string;
  permissionId: string;
  addedAt: string;
}

export interface ProjectSnapshotFile {
  path: string;
  kind: "file" | "directory";
  bytes?: number;
}

export interface ProjectSnapshot {
  rootPath: string;
  rootName: string;
  generatedAt: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  scripts: string[];
  dependencies: string[];
  files: ProjectSnapshotFile[];
  totals: {
    files: number;
    directories: number;
  };
  warnings: string[];
}

/** Result of reading a single project/workspace-resource file for the in-app document viewer
 *  (Graph View, file-node click). Content is capped and utf8-only — see `metis-files:read` in
 *  main.ts for the path-permission check. */
export interface MetisFileReadResult {
  path: string;
  name: string;
  content: string;
  /** True when `content` was cut off at the read cap — the panel disables Save in this case so
   *  an edit can never silently clobber the untruncated rest of the file on disk. */
  truncated: boolean;
}

/** Result of writing back an edited file from the Graph View document viewer
 *  (`metis-files:write` in main.ts). Never throws — failures come back as `ok: false` with a
 *  human-readable `error` so the renderer can show them inline instead of an unhandled rejection. */
export interface MetisFileWriteResult {
  ok: boolean;
  error?: string;
}

export interface ProjectContextSnippet {
  sourcePath: string;
  title: string;
  excerpt: string;
  score: number;
  matchedTerms: string[];
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  level: AuditLevel;
  kind: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** A hand-curated creative constraint bundle the orchestrator picks at build
 *  time so small local models execute a specific taste instead of collapsing
 *  to generic "AI slop" output (docs/FABLE_PLANS.md section 1). */
export interface DesignSeed {
  id: string;
  name: string;
  /** 4-5 hand-picked hex colors. */
  palette: string[];
  type: { display: string; body: string };
  layout: string;
  motion: string;
  voice: string;
}

/** A gallery image distilled into a retrievable style memory
 *  (docs/FABLE_PLANS.md section 4). Palette is always populated via pure-JS
 *  median-cut extraction; caption/moodTags come from a local vision model
 *  when one is installed, otherwise they stay empty and `source` reflects it. */
export interface StyleCard {
  imageId: string;
  boardId: string;
  /** Optional human-given title, editable in the gallery board detail view. */
  title?: string;
  caption: string;
  moodTags: string[];
  palette: string[];
  source: "vision-model" | "palette-only";
  model?: string;
  createdAt: string;
  /** True once a human has edited title/caption/moodTags for this card — user edits
   *  outrank model captions in retrieval scoring (docs/FABLE_PLANS.md section 23). */
  userEdited?: boolean;
}

export type RegistryPackageKind = "skill" | "mcp" | "preset" | "template" | "pipeline";

export interface RegistryPackage {
  schema_version: "0.1.0";
  id: string;
  kind: RegistryPackageKind;
  name: string;
  version: string;
  publisher: string;
  description: string;
  tags: string[];
  permissions_requested: PermissionScope[];
  source_url: string;
  sha256?: string;
  policy_compat?: string;
  /** Optional monospace ASCII-art preview lines shown in the marketplace/registry UI. */
  ascii_art?: string[];
  /** Optional preview image URLs. */
  images?: string[];
  installedAt?: string;
  /** Local install bookkeeping (main-process only, not part of the manifest schema). */
  installedPath?: string;
}

export interface RegistryState {
  sourceUrl: string;
  refreshedAt?: string;
  status: "idle" | "ok" | "offline" | "error";
  error?: string;
  packages: RegistryPackage[];
}

/** One route to a catalog model — a (provider, id) pair the model is reachable
 *  through (docs/FABLE_PLANS.md section 21). A single model, e.g. DeepSeek V3.1,
 *  can be reached via its own API, NVIDIA NIM, OpenRouter, etc; `access` lists
 *  every known route, ordered by preference (most-preferred first). */
export interface ModelAccessRoute {
  provider: ProviderKey;
  id: string;
}

/** `catalog/models.json` entry from the live community registry
 *  (docs/FABLE_PLANS.md section 14). `provider`/`id` are the model's PRIMARY
 *  (default/legacy) route and use the ProviderKey naming used by the registry,
 *  which the renderer maps to its own brand ids.
 *
 *  Schema v2 (docs/FABLE_PLANS.md section 21): a model and the API route it's
 *  reached through are separate axes — the same model may be reachable via
 *  several providers. `access` lists every known route, ordered by preference;
 *  when present it supersedes provider/id for route-resolution purposes. v1
 *  catalog entries (no `access`) are auto-upgraded at load time in main.ts to
 *  a one-route access list of just `{ provider, id }`. */
export interface CatalogModel {
  provider: ProviderKey;
  id: string;
  name: string;
  tier: "cloud" | "local";
  /** Ordered list of routes this model is reachable through. Optional on the
   *  wire (v1 registry payloads omit it); always populated after main.ts's
   *  load-time upgrade, so in-app consumers can rely on it being present. */
  access?: ModelAccessRoute[];
}

export interface ModelCatalogState {
  sourceUrl: string;
  refreshedAt?: string;
  status: "idle" | "ok" | "offline" | "error";
  error?: string;
  models: CatalogModel[];
}

/** One stage of a graph-projected build pipeline (docs/FABLE_PLANS.md section
 *  25) — a compact, main.ts-readable snapshot of one orchestration graph agent
 *  node. The renderer projects the live GraphWorkspace nodes into a list of
 *  these on every change (debounced) and writes them to the app store under
 *  the "graphPipeline" key, since main.ts cannot read the graph's own
 *  localStorage. `provider`/`model` are already normalized to real API ids
 *  (see main.ts's resolveOverrideModel-style normalization) by the time this
 *  reaches the store. */
export interface GraphPipelineStage {
  id: string;
  label: string;
  provider: ProviderKey;
  model: string;
  /** Pinned route provider for this stage's primary model ("Gateway" node
   *  control, formerly "Access via"), if the user set one. Falls back to
   *  defaultGateways, then Auto.
   *  @deprecated kept for back-compat with older consumers/persisted data;
   *  always populated with the same value as `gateway` when `gateway` is set. */
  accessVia?: ProviderKey;
  /** Gateway fallback chain (docs/FABLE_PLANS.md section 25/gateway-fallbacks):
   *  an ordered list of additional route providers to try, in order, before
   *  falling through to the model's remaining access routes by health. */
  gateway?: ProviderKey;
  gatewayFallbacks?: ProviderKey[];
  fallback: Array<{ provider: ProviderKey; model: string }>;
}

/** Store payload for key "graphPipeline" (docs/FABLE_PLANS.md section 25). */
export interface GraphPipelineConfig {
  updatedAt: string;
  stages: GraphPipelineStage[];
}

export interface PulseChangelogEntry {
  date: string;
  title: string;
  blurb: string;
}

export interface PulseNewsEntry {
  title: string;
  url: string;
  blurb?: string;
  /** Optional hero/tile image URL — image-backed tiles get a dark scrim + overlaid title. */
  image?: string;
  /** Optional small uppercase category chip (e.g. "RELEASE", "COMMUNITY"). Defaults to "FEATURED"/"NEWS". */
  tag?: string;
}

/** `featured.json` from the live community registry — Pulse tab content
 *  (docs/FABLE_PLANS.md section 8). */
export interface PulseFeed {
  sourceUrl: string;
  refreshedAt?: string;
  status: "idle" | "ok" | "offline" | "error";
  error?: string;
  updated?: string;
  changelog: PulseChangelogEntry[];
  community: RegistryPackage[];
  news: PulseNewsEntry[];
  /** Optional Discord invite URL for the static "Join the community!" bento tile. */
  discordInvite?: string;
}

export interface PolicyStatus {
  cliPath?: string;
  profilePath?: string;
  available: boolean;
  detail: string;
}

export interface PolicyDecisionInput {
  prompt: string;
  profilePath?: string;
  preset?: RouterPreset;
  localOnly?: boolean;
  cloudOnly?: boolean;
  strictPrivacy?: boolean;
}

export interface PolicyDecisionResult {
  source: "metis-policy-cli" | "sample";
  decision: RouteDecision;
  explanation?: string;
  warnings: string[];
}

export interface ProviderInvokeInput {
  provider: ProviderKey;
  model: string;
  prompt: string;
}

export interface ProviderInvokeResult {
  provider: ProviderKey;
  model: string;
  output: string;
  thoughts?: string;
  source: "ollama" | "anthropic" | "openai" | "gemini" | "deepseek" | "openrouter" | "nvidia" | "groq" | "placeholder";
  auditId: string;
  usage?: { inputTokens: number; outputTokens: number; estimated?: boolean };
}

export type SessionPipelineStatus = "pending" | "running" | "complete" | "skipped" | "error";

export interface SessionPipelineStep {
  id: string;
  label: string;
  detail: string;
  status: SessionPipelineStatus;
  startedAt?: string;
  completedAt?: string;
  auditId?: string;
}

/** A mid-run steering message: sent from any session while a build pipeline is
 *  in flight; absorbed into the next stage prompt. Foundation for multi-session
 *  collaboration (docs/AGENTIC_ROADMAP.md section 3). */
export interface SessionDirective {
  id: string;
  /** projectPath the directive targets, or "global" when no project is selected. */
  scopeKey: string;
  fromConversationId?: string;
  createdAt: string;
  text: string;
  status: "pending" | "applied";
  /** Stage id that consumed the directive. */
  appliedAtStage?: string;
}

/** A model the user pinned in the composer picker. `model` may be a display
 *  name ("Opus 4.8") or a raw API/tag id; the main process normalizes it. */
export interface SessionModelOverride {
  provider: ProviderKey;
  model: string;
  label?: string;
}

export interface SessionRunInput {
  prompt: string;
  conversationId?: string;
  preset?: RouterPreset;
  projectPath?: string;
  /** @deprecated use permissionMode; kept for back-compat and mapped in main.ts
   *  (restricted -> ask, standard -> auto, trusted -> auto). */
  permissionLevel?: "restricted" | "standard" | "trusted";
  permissionMode?: PermissionMode;
  rawPromptStorage?: "local-only" | "hash-only";
  /** When set, bypass Metis Policy routing and call this model directly. */
  modelOverride?: SessionModelOverride;
}

export interface ProjectArtifact {
  kind: "file" | "file_create" | "directory" | "preview";
  label: string;
  path?: string;
  url?: string;
  bytes?: number;
  addedLines?: number;
  removedLines?: number;
}

export interface ProjectToolResult {
  projectRoot: string;
  workspacePath?: string;
  writeMode: "app-managed" | "selected-project";
  previewUrl?: string;
  verified: boolean;
  verificationDetail: string;
  verificationTitle?: string;
  verificationStatusCode?: number;
  verificationDurationMs?: number;
  verificationConsoleErrors?: string[];
  verificationScreenshotPath?: string;
  verificationCommands?: AgentOperation[];
  artifacts: ProjectArtifact[];
}

export type AgentOperationKind =
  | "context_load"
  | "file_edit"
  | "file_create"
  | "directory_create"
  | "command"
  | "browser_check"
  | "mcp_call"
  | "git";

export interface AgentOperation {
  id: string;
  kind: AgentOperationKind;
  label: string;
  target?: string;
  status: "complete" | "warning" | "error";
  addedLines?: number;
  removedLines?: number;
  command?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  url?: string;
  title?: string;
  screenshotPath?: string;
  consoleErrors?: string[];
  snippetCount?: number;
  charCount?: number;
  sourcePaths?: string[];
  permission?: PermissionScope;
  detail?: string;
}

export type SessionTimelineEvent =
  | {
      id: string;
      kind: "text";
      content: string;
    }
  | {
      id: string;
      kind: "route";
      label?: string;
      pipelineName?: string;
    }
  | {
      id: string;
      kind: "stage";
      stageId: string;
    }
  | {
      id: string;
      kind: "operations";
      title: string;
      detail?: string;
      operationIds?: string[];
    };

export type SessionStreamEvent =
  | {
      kind: "timeline";
      event: SessionTimelineEvent;
    }
  | {
      kind: "message_delta";
      delta: string;
    }
  | {
      kind: "thought_delta";
      delta: string;
    }
  | {
      kind: "step";
      step: SessionPipelineStep;
    }
  | {
      kind: "stage";
      stage: OrchestrationStage;
    }
  | {
      kind: "operation";
      operation: AgentOperation;
    }
  | {
      kind: "project";
      project: ProjectToolResult;
    }
  | {
      kind: "complete";
      run: SessionRun;
    }
  | {
      kind: "error";
      message: string;
    }
  | {
      kind: "permission_request";
      request: InRunPermissionRequest;
    }
  | {
      kind: "user_question";
      question: UserQuestionRequest;
    }
  | {
      kind: "stage_call";
      call: {
        id: string;
        stageId: string;
        stageLabel: string;
        provider: ProviderKey;
        model: string;
        promptPreview: string;
        /** Fuller prompt text (capped ~2000 chars), carried only on the "start"
         *  event so the side-chat card's expandable prompt bubble has substance
         *  beyond the ~200-char promptPreview (docs/FABLE_PLANS.md §26). */
        prompt?: string;
        status: "start" | "complete" | "failed";
        output?: string;
        detail?: string;
      };
    };

export interface SessionRun {
  id: string;
  conversationId?: string;
  createdAt: string;
  completedAt: string;
  promptSha256: string;
  promptPreview: string;
  rawPromptStored: boolean;
  projectPath?: string;
  pipelineName: string;
  routeLabel?: string;
  projectSnapshot?: ProjectSnapshot;
  projectContextSnippets?: ProjectContextSnippet[];
  decision: PolicyDecisionResult;
  providerResult?: ProviderInvokeResult;
  modelThoughts?: string;
  projectResult?: ProjectToolResult;
  operations?: AgentOperation[];
  timeline?: SessionTimelineEvent[];
  steps: SessionPipelineStep[];
  assistantText: string;
  stages?: OrchestrationStage[];
  outputUrl?: string;
  warnings: string[];
  designSeed?: { id: string; name: string };
}

export interface OrchestrationStage {
  id: string;
  label: string;
  provider: ProviderKey;
  model: string;
  output: string;
  /** Think-tag / reasoning-field content stripped out of `output`, kept so the
   *  renderer can show it later (never leaks into extracted files or prompts). */
  thoughts?: string;
  /** Red "falling back…" notes recorded while trying primary -> fallback -> local. */
  fallbackNotes: string[];
  failed: boolean;
  /** Number of "is this done?" self-verification passes the critic loop ran
   *  against this stage before accepting the output (docs/FABLE_PLANS.md §22).
   *  Undefined/0 means the critic either wasn't enabled or passed first try. */
  criticPasses?: number;
}

export interface LabExperimentStep {
  id: string;
  label: string;
  detail: string;
  status: "complete" | "warning" | "error";
  durationMs?: number;
}

export interface LabExperimentMetric {
  label: string;
  value: string;
  detail?: string;
}

export interface LabPipelineNode {
  id: string;
  label: string;
  kind: "prompt" | "policy" | "router" | "model" | "verifier" | "result";
  status: "complete" | "warning" | "error";
  detail?: string;
  provider?: ProviderKey;
  model?: string;
}

export interface LabPipelineEdge {
  from: string;
  to: string;
  label?: string;
  status: "complete" | "warning" | "error";
}

export interface OllamaListResult {
  reachable: boolean;
  installed: string[]; // model tags from /api/tags, e.g. "qwen3:8b"
}

export interface OllamaPullProgress {
  model: string;
  status: string; // Ollama's status string ("pulling manifest", "downloading", "verifying", "success", ...)
  completed?: number; // bytes downloaded so far (when Ollama reports it)
  total?: number; // total bytes (when Ollama reports it)
  done: boolean; // terminal event (success OR error)
  error?: string; // set when the pull failed
}

export interface LabExperimentRoute {
  pipelineName: string;
  taskType: RouteDecision["task_type"];
  decisionSource: PolicyDecisionResult["source"];
  selectedRoute: RouteDecision["selected_route"];
  fallbackCount: number;
}

export interface LabExperimentResult {
  id: string;
  createdAt: string;
  prompt: string;
  mode: "live" | "fallback";
  provider?: ProviderKey;
  model?: string;
  output: string;
  route: LabExperimentRoute;
  metrics: LabExperimentMetric[];
  pipelineNodes: LabPipelineNode[];
  pipelineEdges: LabPipelineEdge[];
  steps: LabExperimentStep[];
  warnings: string[];
}

export interface ConversationTurnRecord {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  content: string;
  runId?: string;
  run?: SessionRun;
}

export interface ConversationRecord {
  id: string;
  projectPath?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurnRecord[];
  archived?: boolean;
}

/** A routine = a saved prompt that runs automatically on a schedule, with
 *  results landing in a dedicated conversation per routine (history = audit).
 *  See docs/FABLE_PLANS.md section 12. */
export interface Routine {
  id: string;
  name: string;
  prompt: string;
  schedule:
    | { kind: "interval"; everyMinutes: number }
    | { kind: "daily"; hour: number; minute: number }
    | { kind: "weekly"; weekday: number; hour: number; minute: number };
  projectPath?: string;
  preset?: RouterPreset;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: "ok" | "error";
  lastRunError?: string;
  nextRunAt?: string;
  /** The dedicated conversation, created on first run. */
  conversationId?: string;
  runOnLaunchIfMissed?: boolean;
}
