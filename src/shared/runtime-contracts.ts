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

/** One key/account within a provider's key POOL (docs/DRILL_PLAN.md Phase 6,
 *  §19 phase 2 — "Never Run Dry" grows from per-provider to per-account
 *  cooldown). A provider with no pooled accounts configured still works
 *  exactly as before: main.ts treats its single existing secret as an
 *  implicit one-account pool (see effectiveAccountsForProvider), so this type
 *  and its store are purely additive.
 *
 *  `keyRef` is how the actual secret is looked up at call time — either the
 *  literal sentinel "provider-default" (this account IS the provider's
 *  existing single-key secret, back-compat path) or this account's own id,
 *  which resolves against a separate per-account secret store keyed by
 *  account id (never the provider's classic secret store). Either way the
 *  raw secret value never lives on this object or in any log line.
 *
 *  `cooldownUntil`/`usedToday`/`lastUsed` mirror in-memory run state back to
 *  disk on a best-effort basis (see markAccountCooldown/recordAccountUsage in
 *  main.ts) purely so a later pool-management UI has something to render;
 *  the in-memory maps in main.ts remain the source of truth during a run.
 *  `usedToday` resets lazily (on next read) at UTC midnight. */
export interface ProviderAccount {
  id: string;
  provider: ProviderKey;
  label?: string;
  keyRef: string;
  cooldownUntil?: number;
  usedToday?: number;
  lastUsed?: number;
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
  /** Package id that requested this grant via installPackage, if any. Grants
   *  predating this field (or created outside package install) omit it; such
   *  legacy grants are matched for uninstall purposes by parsing the note's
   *  `Requested by package "<name>" (<id>).` pattern instead. */
  sourcePackageId?: string;
}

export interface PermissionRequest {
  scope: PermissionScope;
  target: string;
  projectPath?: string;
  note?: string;
  sourcePackageId?: string;
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
 *  emitted `<ask_user>...</ask_user>` for a genuinely blocking decision.
 *  `text`/`options` are the original single-question form and stay populated
 *  even when `questions` is present (mirroring the first entry), so a
 *  renderer that only knows the single-question shape keeps working
 *  unchanged. */
export interface UserQuestionRequest {
  id: string;
  text: string;
  options: string[];
  /** Multi-question form (docs/DRILL_PLAN.md B2.3a) — up to 4 questions in
   *  one popup, each with its own option chips and an optional free-text
   *  answer. Undefined for the plain single-question path. */
  questions?: Array<{ text: string; options: string[]; allowCustom?: boolean }>;
}

/** Shape a renderer may resolve an AskUserQuestion with: a single string for
 *  the legacy one-question form, or a string array aligned index-for-index
 *  with `UserQuestionRequest.questions` for the multi-question form
 *  (docs/DRILL_PLAN.md B2.3a). Existing single-answer callers are unaffected. */
export type UserQuestionAnswer = string | string[];

/** Plan the local owner is on. "byo" (bring-your-own keys) is the only plan
 *  today and is always the default — paid tiers are a future decision and
 *  are not implemented yet (docs/DRILL_PLAN.md B3.2a). */
export type MetisPlan = "byo"; // bring-your-own keys; future: paid tiers

/** The local owner profile persisted under the `profile` store key
 *  (docs/DRILL_PLAN.md B3.2a) — not a server account, just a per-install
 *  identity for the app. `onboardedAt` absent means first-run onboarding
 *  has not been completed yet. */
export interface UserProfile {
  name?: string;
  plan: MetisPlan;
  modelPreference?: "local" | "cloud" | "hybrid";
  createdAt: string;
  onboardedAt?: string;
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

/** One turn in the Manager tab's chat with "Metis Manager" (docs/FABLE_PLANS.md
 *  Manager chat round 1) — persisted verbatim under the `managerChat` store key
 *  and sent back to main on every turn so it can rebuild the conversation prompt. */
export interface ManagerChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Actions the Manager (and, later, agentic chat) may propose in a reply —
 *  never auto-executed. The renderer shows each proposal for the owner to
 *  approve/reject; only on approval does it call `metisManager.runAction`,
 *  which re-validates server-side before doing anything (docs/DRILL_PLAN.md
 *  Phase 3 M3 + L6). */
export type ManagerActionKind = "run_in_project" | "add_todo" | "open_view";

export interface ManagerAction {
  kind: ManagerActionKind;
  /** run_in_project: prompt to run; projectPath optional (defaults to current workspace). */
  prompt?: string;
  projectPath?: string;
  /** add_todo: card title; assignee optional ("manager" | "fable"). */
  title?: string;
  assignee?: string;
  /** open_view: a NavKey-ish string (orchestration, marketplace, gallery, benchmark, todo, routines, graph). */
  view?: string;
  /** One short line the Manager gives for why it's proposing this. */
  reason?: string;
}

/** Result of executing exactly one approved ManagerAction via
 *  `metis-manager:action`. `view` echoes back for open_view so the renderer
 *  knows where to navigate; `conversationId` echoes back for run_in_project
 *  so the renderer can surface/open the new session. */
export interface ManagerActionResult {
  ok: boolean;
  error?: string;
  view?: string;
  conversationId?: string;
}

export interface ManagerChatResult {
  reply: string;
  error?: string;
  /** Actions the Manager proposed this turn, parsed out of its reply and
   *  stripped from the displayed text. Never auto-run. */
  actions?: ManagerAction[];
}

/** Stream events for the streaming Manager chat turn (`metis-manager:chat-stream`
 *  / `metis-manager:chat-stream-event`), mirroring the message_delta/thought_delta
 *  shape of SessionStreamEvent (docs/DRILL_PLAN.md Phase 8) so the same
 *  Ollama token-streaming path (invokeOllamaProviderStream) can feed both. Kept
 *  as its own small union rather than reusing SessionStreamEvent directly since
 *  a Manager chat turn has no SessionRun to carry — `complete` instead carries
 *  the exact same ManagerChatResult the non-streaming `metis-manager:chat`
 *  resolves with, so a streaming caller still gets actions/errors identically. */
export type ManagerChatStreamEvent =
  | { kind: "message_delta"; delta: string }
  | { kind: "thought_delta"; delta: string }
  | { kind: "complete"; result: ManagerChatResult }
  | { kind: "error"; message: string };

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
  /** Downscaled (<=768px long edge) JPEG copy of the source image, base64-encoded,
   *  persisted so retrieval can hand the actual reference image to a vision-capable
   *  front-end model — not just its caption/palette (docs/DRILL_PLAN.md Phase 2, L9).
   *  Optional: cards generated before this field existed simply have neither, and
   *  retrieval falls back to text-only, exactly as before. */
  imageBase64?: string;
  imageMime?: string;
}

/** A single image pulled in via the gallery's URL/Pinterest import path
 *  (docs/DRILL_PLAN.md Phase 2, L15). `src` is a downscaled JPEG data URL,
 *  mirroring the storage format used elsewhere for gallery images so the
 *  renderer's existing image-handling code can consume it unchanged. */
export interface ImportedImage {
  src: string;
  mimeType: string;
  sourceUrl: string;
}

/** Result of `metis-gallery:import-urls` / `metis-gallery:import-pinterest`.
 *  Never throws over IPC — every failure path comes back as `{ ok: false, error }`
 *  with `images: []`. `note` carries non-fatal context (e.g. how many of the
 *  supplied links weren't images, or why a Pinterest board came back empty) so
 *  the renderer can show it alongside a partial/empty result. */
export interface ImageImportResult {
  ok: boolean;
  error?: string;
  images: ImportedImage[];
  note?: string;
}

/** A single tool a probed MCP server reported via `tools/list`
 *  (docs/DRILL_PLAN.md Phase 4, MCP client wiring phase 1). */
export interface McpTool {
  name: string;
  description?: string;
}

/** Result of `metis-mcp:probe` — spawns an installed MCP server's stdio
 *  process, performs the JSON-RPC handshake, and enumerates its tools. Never
 *  throws over IPC: every failure path (missing package, spawn error,
 *  timeout, malformed response) comes back as `{ ok: false, error }`. */
export interface McpProbeResult {
  ok: boolean;
  error?: string;
  serverName?: string;
  tools?: McpTool[];
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
  /** Fallback models for this stage. Each entry may carry its OWN gateway +
   *  gateway fallbacks (docs/DRILL_PLAN.md B11.3): gateways are a property of
   *  a specific model, not the node, since a node now holds several models
   *  (primary + fallback chain). Entries without gateway fields keep the old
   *  behavior (default gateways / health-ordered routes). The stage-level
   *  `gateway`/`gatewayFallbacks` above remain the PRIMARY model's config. */
  fallback: Array<{ provider: ProviderKey; model: string; gateway?: ProviderKey; gatewayFallbacks?: ProviderKey[] }>;
}

/** Store payload for key "graphPipeline" (docs/FABLE_PLANS.md section 25). */
export interface GraphPipelineConfig {
  updatedAt: string;
  stages: GraphPipelineStage[];
}

/** Result of `metis-updates:check` (titlebar "Update available" badge) — compares
 *  `app.getVersion()` against the latest tagged GitHub release. Guarded to never
 *  throw: any fetch/parse failure (offline, no releases yet, rate-limited) comes
 *  back as `{ updateAvailable: false, currentVersion }` rather than rejecting.
 *  NOTE: this only checks + surfaces a badge that links to the release page —
 *  true auto-download/install (electron-updater against GitHub Releases) is a
 *  follow-up that needs a publish config, a packaged app, and published releases. */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  url?: string;
  notes?: string;
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

/** Raw image bytes for a single attachment, threaded from SessionAttachment
 *  through to a provider invoke. `data` is RAW base64 (no data: prefix). Only
 *  vision-capable providers (anthropic/openai/gemini/ollama) actually use
 *  this — everyone else silently ignores it (see invokeCloudProvider). */
export interface ProviderImageInput {
  data: string;
  mimeType: string;
}

export interface ProviderInvokeInput {
  provider: ProviderKey;
  model: string;
  prompt: string;
  /** Optional reference images for this single call. Undefined/empty means
   *  byte-identical behaviour to before this field existed. */
  images?: ProviderImageInput[];
}

export interface ProviderInvokeResult {
  provider: ProviderKey;
  model: string;
  output: string;
  thoughts?: string;
  source: "ollama" | "anthropic" | "openai" | "gemini" | "deepseek" | "openrouter" | "nvidia" | "groq" | "placeholder";
  auditId: string;
  usage?: { inputTokens: number; outputTokens: number; estimated?: boolean };
  /** Time-to-first-token (DRILL_PLAN E1): ms from when this provider request
   *  was about to be sent to the moment its first streamed delta (output or
   *  thought) was observed. Only populated for a real streaming call (today:
   *  the Ollama streaming path, invokeOllamaProviderStream) — undefined for
   *  every non-streaming provider call, including the placeholder/error
   *  fallbacks above, so this is purely additive telemetry. */
  ttftMs?: number;
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
  /** What kind of message this is. Absent means "steer" (the original mid-run
   *  steering behavior: absorbed into the next stage prompt). Added for
   *  agent-to-agent bus (docs/DRILL_PLAN.md Phase 5b). */
  kind?: "steer" | "question" | "review_request" | "handoff";
  /** Managed-agent name (see FANOUT_AGENT_NAMES in main.ts) that authored this
   *  directive, when it was emitted by a fan-out sub-agent rather than the user. */
  fromAgent?: string;
  /** Managed-agent name this directive targets. Absent means broadcast to
   *  every consumer (the pipeline as a whole), preserving pre-5b behavior. */
  toAgent?: string;
}

/** A model the user pinned in the composer picker. `model` may be a display
 *  name ("Opus 4.8") or a raw API/tag id; the main process normalizes it. */
export interface SessionModelOverride {
  provider: ProviderKey;
  model: string;
  label?: string;
}

/** Metis Gateway (DRILL_PLAN P10.1) — status of the loopback OpenAI-compatible
 *  local server a Settings toggle can wire up. `port` is the actually-bound
 *  port when running (may differ from the configured `gatewayPort` store key
 *  if that port was busy — startGateway reports the real bind), or the
 *  configured port when stopped. `token` is the per-install bearer token,
 *  included so the UI can show/copy it; never logged anywhere else. */
export interface GatewayStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
}

/** A user-attached reference image for a session run. `dataBase64` is RAW
 *  base64 (no `data:<mime>;base64,` prefix) — the composer attach UI (a
 *  separate follow-up round) is responsible for stripping it before sending.
 *  main.ts defensively strips a prefix anyway if one slips through. */
export interface SessionAttachment {
  id?: string;
  name: string;
  mimeType: string;
  dataBase64: string;
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
  /** Reference images for this run (front-end build stage, edit stage, and
   *  plain chat). Undefined/empty means byte-identical behaviour to before
   *  this field existed. */
  attachments?: SessionAttachment[];
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
        /** Which named sub-agent produced this call, when the run is in
         *  N-agent fan-out mode (docs/DRILL_PLAN.md Phase 5, sub-round 5a).
         *  Undefined for every ordinary single-pipeline stage call — the
         *  renderer treats a missing agentName as "no side-chat grouping",
         *  same as before this field existed. */
        agentName?: string;
      };
    };

/** A single file-territory claim recorded by the fan-out engine's in-memory
 *  ledger (docs/DRILL_PLAN.md Phase 5, sub-round 5a): which sub-agent ended up
 *  owning a given generated file path once claims were resolved. Not used to
 *  persist the ledger itself (that lives only in main.ts for the run's
 *  lifetime) — this is the shape surfaced to the renderer afterward. */
export interface FileClaim {
  path: string;
  agentName: string;
}

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
  /** Time-to-first-token for this run's provider call (DRILL_PLAN E1),
   *  promoted from providerResult.ttftMs the same way modelThoughts is
   *  promoted from providerResult.thoughts. Undefined whenever the run's
   *  provider call wasn't a streaming call that produced a token (e.g. cloud
   *  providers today, or an Ollama call with no active stream controller) —
   *  a follow-up round wires this into the renderer once real readings exist. */
  ttftMs?: number;
  /** Oracle v0.3 (DRILL_PLAN O4): true when this run's answer was served
   *  from Oracle's pre-drafted response for an exact assembled-prompt match
   *  (same pinned local model, same default sampling) instead of a fresh
   *  generation. The renderer labels these honestly. */
  oracleServed?: boolean;
  /** Depth routing (DRILL_PLAN B11): how heavy this chat turn was judged.
   *  1 = trivial (routed straight to the cheapest local tier, minimal
   *  ceremony), 2 = standard (normal policy routing), 3 = deep (routed
   *  straight to the configured frontier tier). Only set when the
   *  depthRoutingEnabled flag was on and the run was Auto (not pinned). */
  depth?: 1 | 2 | 3;
  projectResult?: ProjectToolResult;
  operations?: AgentOperation[];
  timeline?: SessionTimelineEvent[];
  steps: SessionPipelineStep[];
  assistantText: string;
  stages?: OrchestrationStage[];
  outputUrl?: string;
  warnings: string[];
  designSeed?: { id: string; name: string };
  /** Actions the assistant proposed during a general-chat turn (parsed from a
   *  trailing ```metis-actions block via extractManagerActions, same as the
   *  Manager tab) for the owner to approve in the UI. Undefined when the
   *  reply proposed nothing, and never populated on build-pipeline runs. */
  actions?: ManagerAction[];
  /** N-agent fan-out metadata (docs/DRILL_PLAN.md Phase 5, sub-round 5a):
   *  populated only when this build ran through the multi-agent fan-out
   *  engine (opt-in via the `fanoutEnabled` store key, off by default)
   *  instead of the single build pipeline. Undefined on every other run,
   *  including ordinary single-pipeline builds — those are byte-identical to
   *  before this field existed. `claimedPaths` per agent reflects only the
   *  paths that WON their file-claim ledger check; a path another agent
   *  claimed first is silently absent here (and logged in the run timeline). */
  fanout?: {
    agents: { name: string; task: string; claimedPaths: string[] }[];
    /** Absolute path to the METIS-SPEC.md living-spec doc this fan-out run wrote into the
     *  workspace root (docs/DRILL_PLAN.md P10.3), when one was written. Undefined whenever
     *  there was no writable workspace to place it in (fan-out still runs; the spec is just
     *  skipped) — never a fallback app-data path. */
    specPath?: string;
  };
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
  /** True once the user has manually renamed this conversation — permanently
   *  opts it out of local-model auto-titling. */
  titleManual?: boolean;
  /** True once a local-model auto-title attempt has run (success or failure)
   *  for this conversation, so the one-shot title job never re-fires. */
  autoTitleAttempted?: boolean;
}

/** Result of a Markdown export request (Settings > Privacy > Export). Never throws;
 *  cancelled dialogs and failures both come back as ok: false. */
export interface ConversationExportResult {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
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
