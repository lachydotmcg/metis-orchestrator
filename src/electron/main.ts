import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sampleDecision } from "../shared/sample-decision.js";
import { designSeeds } from "../shared/design-seeds.js";
import type { RouteDecision } from "../shared/policy-contract.js";
import type {
  AuditEvent,
  AgentOperation,
  ConversationExportResult,
  ConversationRecord,
  ConversationTurnRecord,
  LabExperimentResult,
  LabExperimentStep,
  InRunPermissionRequest,
  PermissionGrant,
  PermissionMode,
  PermissionRequest,
  PermissionVerdict,
  PolicyDecisionInput,
  OrchestrationStage,
  PolicyDecisionResult,
  PolicyStatus,
  ProviderAccount,
  ProviderImageInput,
  ProviderInvokeInput,
  ProviderInvokeResult,
  ProviderKey,
  ProviderStatus,
  DesignSeed,
  MetisFileReadResult,
  MetisFileWriteResult,
  ProjectArtifact,
  ProjectSnapshot,
  ProjectSnapshotFile,
  ProjectToolResult,
  ProjectWorkspace,
  ProjectWorkspaceResource,
  ProjectWorkspaceSelectionResult,
  CatalogModel,
  GraphPipelineConfig,
  ModelAccessRoute,
  ModelCatalogState,
  OllamaListResult,
  OllamaPullProgress,
  McpProbeResult,
  McpTool,
  ImportedImage,
  ImageImportResult,
  PulseFeed,
  RegistryPackage,
  RegistryPackageKind,
  RegistryState,
  SessionDirective,
  SessionModelOverride,
  SessionStreamEvent,
  SessionTimelineEvent,
  SessionPipelineStep,
  SessionPipelineStatus,
  SessionRun,
  SessionRunInput,
  SessionAttachment,
  SecretStatus,
  Routine,
  StyleCard,
  UserQuestionRequest,
  UserQuestionAnswer,
  ManagerChatMessage,
  ManagerChatResult,
  ManagerAction,
  ManagerActionKind,
  ManagerActionResult,
  UpdateCheckResult,
  UserProfile
} from "../shared/runtime-contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storeKeyPattern = /^[a-zA-Z0-9_-]+$/;
const providerKeyPattern = /^[a-z0-9_-]+$/;
const execFileAsync = promisify(execFile);
const projectPreviewServers = new Map<string, { server: Server; url: string }>();

type PreviewVerificationResult = {
  ok: boolean;
  detail: string;
  title?: string;
  statusCode?: number;
  consoleErrors?: string[];
  screenshotPath?: string;
};

type BrowserPreviewEvidence = Pick<PreviewVerificationResult, "title" | "consoleErrors" | "screenshotPath"> & {
  markerReady?: boolean;
};

type StoredSecret = {
  value: string;
  storage: "safeStorage" | "plain-local";
  updatedAt: string;
};

type StoredSecrets = Partial<Record<ProviderKey, StoredSecret>>;

const providerInfo: Record<ProviderKey, { label: string; defaultModel?: string }> = {
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-4-6" },
  openai: { label: "OpenAI", defaultModel: "gpt-5.1" },
  gemini: { label: "Google Gemini", defaultModel: "gemini-2.5-pro" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-chat" },
  openrouter: { label: "OpenRouter", defaultModel: "auto" },
  // Free-tier pool providers (docs/FABLE_PLANS.md section 19, "Never Run Dry").
  // Both are OpenAI-chat-schema-compatible; see invokeCloudProvider below.
  nvidia: { label: "NVIDIA NIM", defaultModel: "deepseek-ai/deepseek-v3.1" },
  groq: { label: "Groq", defaultModel: "llama-3.3-70b-versatile" },
  ollama: { label: "Ollama", defaultModel: "qwen3:8b" }
};

const providerEnvNames: Partial<Record<ProviderKey, string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  groq: ["GROQ_API_KEY"]
};

// --- Never Run Dry: quota/rate-limit cooldown tracking (docs/FABLE_PLANS.md
// section 19). Keyed by provider (phase 2 will key by pooled account instead).
// Populated when invokeCloudProvider detects a 429/quota-ish failure; read by
// callStageWithFallback (skip cooling entries) and healthCheckProvider/listProviders.
const providerCooldowns = new Map<ProviderKey, number>();
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const QUOTA_ERROR_PATTERN = /rate.?limit|quota|insufficient.?(balance|credits)|exceeded/i;

/** Error thrown by invokeCloudProvider for HTTP failures; carries the status
 *  code and a parsed Retry-After (seconds) when the response provided one, so
 *  quota-rotation can set an accurate cooldown instead of always defaulting. */
class ProviderHttpError extends Error {
  status?: number;
  retryAfterSeconds?: number;
  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isQuotaError(error: unknown): error is ProviderHttpError {
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return QUOTA_ERROR_PATTERN.test(message);
}

function markProviderCooldown(provider: ProviderKey, error: unknown): number {
  const retryAfterSeconds = error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined;
  const durationMs = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_COOLDOWN_MS;
  const until = Date.now() + durationMs;
  providerCooldowns.set(provider, until);
  return until;
}

function providerCooldownUntil(provider: ProviderKey): number | undefined {
  const until = providerCooldowns.get(provider);
  if (!until) return undefined;
  if (until <= Date.now()) {
    providerCooldowns.delete(provider);
    return undefined;
  }
  return until;
}

function isProviderCooling(provider: ProviderKey): boolean {
  return providerCooldownUntil(provider) !== undefined;
}

function formatCooldownDuration(untilMs: number): string {
  const remainingMs = Math.max(0, untilMs - Date.now());
  const minutes = Math.round(remainingMs / 60000);
  if (minutes <= 0) return "under a minute";
  return `${minutes}m`;
}

// --- Key POOLS (docs/DRILL_PLAN.md Phase 6, §19 phase 2): multiple
// keys/accounts per provider, each with its OWN quota/cooldown, rotating
// across a provider's accounts before the chain falls to the next provider.
// This is purely additive over the single-key system above: a provider with
// zero pooled accounts configured still behaves byte-for-byte as before
// (see effectiveAccountsForProvider's back-compat branch). The pool
// management UI itself is a later renderer round — this is the backend
// engine only.

/** keyRef sentinel meaning "this account IS the provider's existing single
 *  key" (the back-compat implicit account synthesized when no real pool is
 *  configured). Any other keyRef is treated as a real pooled account id and
 *  resolved against the separate per-account secret store below. */
const IMPLICIT_ACCOUNT_KEYREF = "provider-default";

function implicitAccountId(provider: ProviderKey): string {
  return `implicit:${provider}`;
}

function isSameUtcDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate();
}

async function readProviderAccounts(): Promise<ProviderAccount[]> {
  const raw = await readStoreValue<unknown>("providerAccounts", []);
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const valid: ProviderAccount[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<ProviderAccount>;
    if (typeof candidate.id !== "string" || typeof candidate.provider !== "string" || typeof candidate.keyRef !== "string") continue;
    if (!(candidate.provider in providerInfo)) continue;
    const account: ProviderAccount = {
      id: candidate.id,
      provider: candidate.provider as ProviderKey,
      keyRef: candidate.keyRef,
      label: typeof candidate.label === "string" ? candidate.label : undefined,
      cooldownUntil: typeof candidate.cooldownUntil === "number" ? candidate.cooldownUntil : undefined,
      usedToday: typeof candidate.usedToday === "number" ? candidate.usedToday : 0,
      lastUsed: typeof candidate.lastUsed === "number" ? candidate.lastUsed : undefined
    };
    // Lazy UTC-midnight reset (docs/DRILL_PLAN.md Phase 6): usedToday only
    // reflects calls made since the account's lastUsed's UTC day.
    if (account.lastUsed !== undefined && !isSameUtcDay(account.lastUsed, now)) {
      account.usedToday = 0;
    }
    valid.push(account);
  }
  return valid;
}

async function writeProviderAccounts(accounts: ProviderAccount[]): Promise<void> {
  await writeStoreValue("providerAccounts", accounts);
}

/** Per-account in-memory cooldown map, mirroring providerCooldowns above but
 *  keyed by account id instead of provider — this is the real granularity
 *  quota rotation now operates at. Seeded from any persisted cooldownUntil
 *  still in the future (see effectiveAccountsForProvider) so a cooldown
 *  survives an app restart, same intent as the provider-level map already
 *  had informally via re-triggering on the next 429. */
const accountCooldowns = new Map<string, number>();

function markAccountCooldown(accountId: string, error: unknown): number {
  const retryAfterSeconds = error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined;
  const durationMs = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_COOLDOWN_MS;
  const until = Date.now() + durationMs;
  accountCooldowns.set(accountId, until);
  void persistAccountCooldown(accountId, until);
  return until;
}

function accountCooldownUntil(accountId: string): number | undefined {
  const until = accountCooldowns.get(accountId);
  if (!until) return undefined;
  if (until <= Date.now()) {
    accountCooldowns.delete(accountId);
    return undefined;
  }
  return until;
}

function isAccountCooling(accountId: string): boolean {
  return accountCooldownUntil(accountId) !== undefined;
}

/** Best-effort disk mirror of an account's cooldown, purely so a later pool
 *  UI can show it without needing this process's in-memory state. Never
 *  awaited by callers on the hot path — a persistence hiccup here must never
 *  fail (or even slow down) the actual provider call. The implicit back-compat
 *  account has no persisted record (id never matches a stored entry), so this
 *  is a silent no-op for the single-key case, matching provider-level
 *  cooldowns which were never persisted either. */
async function persistAccountCooldown(accountId: string, until: number): Promise<void> {
  try {
    const accounts = await readProviderAccounts();
    const idx = accounts.findIndex((account) => account.id === accountId);
    if (idx === -1) return;
    accounts[idx] = { ...accounts[idx], cooldownUntil: until };
    await writeProviderAccounts(accounts);
  } catch {
    // Telemetry only; the in-memory accountCooldowns map remains authoritative.
  }
}

/** Increments usedToday/lastUsed for a successful call against a real pooled
 *  account. No-ops for the implicit back-compat account (nothing to persist —
 *  it isn't a real store entry) and swallows any persistence error, since
 *  this is telemetry for a future pool UI, never load-bearing for the call
 *  that just succeeded. */
async function recordAccountUsage(account: ProviderAccount | undefined): Promise<void> {
  if (!account || account.keyRef === IMPLICIT_ACCOUNT_KEYREF) return;
  try {
    const accounts = await readProviderAccounts();
    const idx = accounts.findIndex((entry) => entry.id === account.id);
    if (idx === -1) return;
    const existing = accounts[idx];
    accounts[idx] = { ...existing, usedToday: (existing.usedToday ?? 0) + 1, lastUsed: Date.now() };
    await writeProviderAccounts(accounts);
  } catch {
    // Telemetry only.
  }
}

/** Resolves the effective account POOL for a provider: real pooled accounts
 *  if any are configured, else a single synthesized implicit account
 *  wrapping the existing single-key secrets path (back-compat — a provider
 *  with zero pooled accounts behaves exactly as it did before this round).
 *  Ollama has no key/account concept (local runtime), so it always returns
 *  []; callers must keep treating ollama as they did before this round. */
async function effectiveAccountsForProvider(provider: ProviderKey): Promise<ProviderAccount[]> {
  if (provider === "ollama") return [];
  const all = await readProviderAccounts();
  const pooled = all.filter((account) => account.provider === provider);
  if (pooled.length > 0) {
    // Seed in-memory cooldowns from any persisted cooldownUntil still in the
    // future so a restart doesn't forget an account was cooling.
    const now = Date.now();
    for (const account of pooled) {
      if (account.cooldownUntil && account.cooldownUntil > now && !accountCooldowns.has(account.id)) {
        accountCooldowns.set(account.id, account.cooldownUntil);
      }
    }
    return pooled;
  }
  const configured = await isProviderConfigured(provider);
  if (!configured) return [];
  return [{ id: implicitAccountId(provider), provider, keyRef: IMPLICIT_ACCOUNT_KEYREF, label: "Default" }];
}

/** Picks the rotation order for a provider's non-cooling accounts: first
 *  account not cooling, preferring least-recently-used for fairness (never
 *  used = tried first). Callers walk this list in order, trying the next
 *  entry only when the previous one hits a quota error — see
 *  callStageWithFallback. */
function orderAccountsForRotation(accounts: ProviderAccount[]): ProviderAccount[] {
  return accounts
    .filter((account) => !isAccountCooling(account.id))
    .slice()
    .sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
}

/** Mirrors pooled per-account cooldown state onto the legacy per-provider
 *  providerCooldowns map so every existing provider-level consumer (health
 *  reporting, route resolution, chain-expansion ordering) keeps working
 *  unchanged: a provider now only reads as "cooling" once ALL of its
 *  accounts are cooling, and clears the moment any account becomes usable
 *  again. No-op when there are no accounts at all (the legacy single-key
 *  markProviderCooldown/providerCooldowns path — e.g. "not configured" or
 *  ollama — remains the sole source of truth in that case). */
async function syncProviderCooldownFromAccounts(provider: ProviderKey, accounts: ProviderAccount[]): Promise<void> {
  if (provider === "ollama" || accounts.length === 0) return;
  const untils = accounts.map((account) => accountCooldownUntil(account.id));
  const allCooling = untils.every((until) => until !== undefined);
  if (allCooling) {
    providerCooldowns.set(provider, Math.max(...(untils as number[])));
  } else {
    providerCooldowns.delete(provider);
  }
}

/** Separate per-account secret store, keyed by ProviderAccount.id — kept
 *  entirely apart from the classic per-provider `secrets` store so the
 *  back-compat implicit account (keyRef === IMPLICIT_ACCOUNT_KEYREF) never
 *  collides with a real pooled account's own credential. Same
 *  encrypt/decrypt helpers as the classic store; secrets are never logged
 *  here either. */
async function readAccountSecrets(): Promise<Partial<Record<string, StoredSecret>>> {
  return readStoreValue<Partial<Record<string, StoredSecret>>>("account-secrets", {});
}

async function writeAccountSecrets(value: Partial<Record<string, StoredSecret>>): Promise<void> {
  await writeStoreValue("account-secrets", value);
}

async function setAccountSecret(accountId: string, value: string): Promise<void> {
  const store = await readAccountSecrets();
  if (!value.trim()) {
    delete store[accountId];
  } else {
    store[accountId] = encryptSecret(value.trim());
  }
  await writeAccountSecrets(store);
}

async function readAccountSecret(accountId: string): Promise<string | undefined> {
  const store = await readAccountSecrets();
  const secret = store[accountId];
  if (!secret) return undefined;
  try {
    return decryptSecret(secret);
  } catch {
    return undefined;
  }
}

/** Resolves the actual secret value for one account, dispatching on keyRef:
 *  the implicit back-compat account reads through the existing single-key
 *  path (readProviderSecret, defined further below — safe forward reference
 *  since this is only ever called at invoke time, never at module load), a
 *  real pooled account reads its own entry in the account-secrets store. */
async function resolveAccountSecret(account: ProviderAccount): Promise<string | undefined> {
  if (account.keyRef === IMPLICIT_ACCOUNT_KEYREF) {
    return readProviderSecret(account.provider);
  }
  return readAccountSecret(account.id);
}

/** Shared "does this provider have a usable credential" check — the same test
 *  the health system (listProviders/healthCheckProvider) uses, reused here so
 *  route resolution (docs/FABLE_PLANS.md section 21) and the health UI never
 *  disagree about what "configured" means. Ollama is always configured (it's
 *  a local runtime, not a key). */
async function isProviderConfigured(provider: ProviderKey): Promise<boolean> {
  if (provider === "ollama") return true;
  const secrets = await readSecrets();
  if (secrets[provider]) return true;
  const statuses = await listSecrets();
  return Boolean(statuses.find((status) => status.provider === provider)?.hasSecret);
}

/** Resolves the best access route for a catalog model (docs/FABLE_PLANS.md
 *  section 21 — "models × routes"): a model and the API it's reached through
 *  are separate axes, so a model with several routes (e.g. DeepSeek V3.1 via
 *  its own API, NVIDIA NIM, or OpenRouter) should fall back across ROUTES
 *  before ever falling back to a different MODEL.
 *
 *  Resolution order:
 *   1. The explicit pinned provider, if it appears in `access` AND is configured.
 *   2. The first route whose provider is configured AND not cooling.
 *   3. The first configured route even if it's cooling (a cooling route beats none).
 *   4. null — no route in `access` has a configured credential at all.
 */
async function resolveModelRoute(access: ModelAccessRoute[], pinned?: ProviderKey): Promise<ModelAccessRoute | null> {
  if (pinned) {
    const pinnedRoute = access.find((route) => route.provider === pinned);
    if (pinnedRoute && (await isProviderConfigured(pinnedRoute.provider))) return pinnedRoute;
  }

  const configuredFlags = await Promise.all(access.map((route) => isProviderConfigured(route.provider)));
  const configuredRoutes = access.filter((_, index) => configuredFlags[index]);

  // Key POOLS (docs/DRILL_PLAN.md Phase 6): resync the legacy per-provider
  // cooldown map from each route's pooled accounts first, so a provider only
  // reads as cooling here once ALL of its accounts are — isProviderCooling
  // below stays a plain sync read/writer pair, unchanged.
  await Promise.all(
    configuredRoutes.map(async (route) => {
      const accounts = await effectiveAccountsForProvider(route.provider);
      await syncProviderCooldownFromAccounts(route.provider, accounts);
    })
  );

  const healthyRoute = configuredRoutes.find((route) => !isProviderCooling(route.provider));
  if (healthyRoute) return healthyRoute;

  if (configuredRoutes.length > 0) return configuredRoutes[0];

  return null;
}

/** The live community registry (docs/FABLE_PLANS.md sections 5, 8, 14). Raw GitHub
 *  base for `index.json`, `packages/<id>/manifest.json`, `catalog/models.json`,
 *  and `featured.json`. Overridable via the optional `sourceUrl` arg on refresh. */
const METIS_REGISTRY_BASE_URL = "https://raw.githubusercontent.com/lachydotmcg/metis-registry/main";
const REGISTRY_PACKAGE_KINDS = new Set<RegistryPackageKind>(["skill", "mcp", "preset", "template", "pipeline"]);

const registryFallbackPackages: RegistryPackage[] = [
  {
    schema_version: "0.1.0",
    id: "skill.ui-ux-pro-max",
    kind: "skill",
    name: "UI/UX Pro Max",
    version: "0.1.0",
    publisher: "Metis",
    description: "Frontend design review and build guidance for polished web/app surfaces.",
    tags: ["frontend", "design", "review"],
    permissions_requested: [],
    source_url: "https://github.com/lachydotmcg/metis-orchestrator"
  },
  {
    schema_version: "0.1.0",
    id: "mcp.browser",
    kind: "mcp",
    name: "Browser Control",
    version: "0.1.0",
    publisher: "Metis",
    description: "Controlled browser inspection for local previews and UI verification.",
    tags: ["browser", "testing", "frontend"],
    permissions_requested: ["network.web"],
    source_url: "https://github.com/lachydotmcg/metis-orchestrator"
  },
  {
    schema_version: "0.1.0",
    id: "preset.local-first",
    kind: "preset",
    name: "Local-first Router",
    version: "0.1.0",
    publisher: "Metis",
    description: "Prefer measured local models, with cloud fallback when policy evidence says it matters.",
    tags: ["local", "privacy", "routing"],
    permissions_requested: ["network.provider"],
    source_url: "https://github.com/lachydotmcg/metis-orchestrator",
    policy_compat: "0.1.x"
  }
];

function storePath(key: string): string {
  if (!storeKeyPattern.test(key)) {
    throw new Error(`Invalid store key: ${key}`);
  }
  return join(app.getPath("userData"), "metis-store", `${key}.json`);
}

async function readStoreValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(storePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeStoreValue<T>(key: string, value: T): Promise<void> {
  const target = storePath(key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), "utf8");
}

function dataPath(...parts: string[]): string {
  return join(app.getPath("userData"), "metis-store", ...parts);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function appendAudit(level: AuditEvent["level"], kind: string, summary: string, metadata?: Record<string, unknown>): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    level,
    kind,
    summary,
    metadata
  };
  const target = dataPath("audit-log.jsonl");
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

async function listAudit(limit = 40): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(dataPath("audit-log.jsonl"), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditEvent)
      .reverse();
  } catch {
    return [];
  }
}

function validateProvider(provider: string): asserts provider is ProviderKey {
  if (!providerKeyPattern.test(provider) || !(provider in providerInfo)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function readSecrets(): Promise<StoredSecrets> {
  return readStoreValue<StoredSecrets>("secrets", {});
}

async function writeSecrets(value: StoredSecrets): Promise<void> {
  await writeStoreValue("secrets", value);
}

function encryptSecret(value: string): StoredSecret {
  const updatedAt = new Date().toISOString();
  if (safeStorage.isEncryptionAvailable()) {
    return {
      value: safeStorage.encryptString(value).toString("base64"),
      storage: "safeStorage",
      updatedAt
    };
  }
  return {
    value: Buffer.from(value, "utf8").toString("base64"),
    storage: "plain-local",
    updatedAt
  };
}

function decryptSecret(secret: StoredSecret): string {
  const bytes = Buffer.from(secret.value, "base64");
  if (secret.storage === "safeStorage") {
    return safeStorage.decryptString(bytes);
  }
  return bytes.toString("utf8");
}

async function setSecret(provider: ProviderKey, value: string): Promise<SecretStatus> {
  validateProvider(provider);
  const secrets = await readSecrets();
  if (!value.trim()) {
    delete secrets[provider];
    await writeSecrets(secrets);
    await appendAudit("info", "secret.delete", `${providerInfo[provider].label} API key cleared.`, { provider });
    return { provider, hasSecret: false, storage: "none" };
  }
  secrets[provider] = encryptSecret(value.trim());
  await writeSecrets(secrets);
  await appendAudit("info", "secret.set", `${providerInfo[provider].label} API key saved.`, {
    provider,
    storage: secrets[provider]?.storage
  });
  return secretStatus(provider, secrets);
}

function secretStatus(provider: ProviderKey, secrets: StoredSecrets): SecretStatus {
  const secret = secrets[provider];
  const envName = providerEnvNames[provider]?.find((name) => Boolean(process.env[name]));
  if (!secret && envName) {
    return {
      provider,
      hasSecret: true,
      storage: "environment"
    };
  }
  return {
    provider,
    hasSecret: Boolean(secret),
    storage: secret?.storage ?? "none",
    updatedAt: secret?.updatedAt
  };
}

async function listSecrets(): Promise<SecretStatus[]> {
  const secrets = await readSecrets();
  return (Object.keys(providerInfo) as ProviderKey[]).map((provider) => secretStatus(provider, secrets));
}

async function deleteSecret(provider: ProviderKey): Promise<void> {
  validateProvider(provider);
  const secrets = await readSecrets();
  delete secrets[provider];
  await writeSecrets(secrets);
  await appendAudit("info", "secret.delete", `${providerInfo[provider].label} API key cleared.`, { provider });
}

/** Pooled-state suffix for the health `detail` string when a provider has a
 *  real pool (>1 account) configured — e.g. "3/4 accounts available." Returns
 *  "" for the back-compat single/implicit-account case so existing detail
 *  text is untouched until a user actually adds a second account. */
function poolDetailSuffix(accounts: ProviderAccount[]): string {
  if (accounts.length <= 1) return "";
  const available = accounts.filter((account) => !isAccountCooling(account.id)).length;
  return ` (${available}/${accounts.length} accounts available)`;
}

async function listProviders(): Promise<ProviderStatus[]> {
  const secrets = await readSecrets();
  const secretStatuses = await listSecrets();
  const providerKeys = Object.keys(providerInfo) as ProviderKey[];
  // Key POOLS (docs/DRILL_PLAN.md Phase 6): resync every non-ollama
  // provider's legacy cooldown entry from its pooled accounts before
  // building statuses below, so this list reflects "all accounts cooling",
  // not just the last single-key 429.
  const poolByProvider = new Map<ProviderKey, ProviderAccount[]>();
  await Promise.all(
    providerKeys
      .filter((provider) => provider !== "ollama")
      .map(async (provider) => {
        const accounts = await effectiveAccountsForProvider(provider);
        await syncProviderCooldownFromAccounts(provider, accounts);
        poolByProvider.set(provider, accounts);
      })
  );
  return (Object.entries(providerInfo) as Array<[ProviderKey, (typeof providerInfo)[ProviderKey]]>).map(([provider, info]) => {
    if (provider === "ollama") {
      return {
        provider,
        label: info.label,
        configured: true,
        status: "unknown",
        detail: "Local runtime. Run health check to confirm the Ollama server is available.",
        defaultModel: info.defaultModel
      };
    }
    const configured = Boolean(secrets[provider]) || Boolean(secretStatuses.find((status) => status.provider === provider)?.hasSecret);
    const cooldownUntil = providerCooldownUntil(provider);
    const poolSuffix = poolDetailSuffix(poolByProvider.get(provider) ?? []);
    if (cooldownUntil) {
      return {
        provider,
        label: info.label,
        configured,
        status: "unavailable",
        detail: `Cooling down until ${new Date(cooldownUntil).toLocaleTimeString()} after a quota/rate-limit response.${poolSuffix}`,
        defaultModel: info.defaultModel
      };
    }
    return {
      provider,
      label: info.label,
      configured,
      status: configured ? "available" : "not_configured",
      detail:
        (configured
          ? secretStatuses.find((status) => status.provider === provider)?.storage === "environment"
            ? "API key available from the launch environment."
            : "API key stored locally."
          : "Add a provider-level API key in Settings.") + poolSuffix,
      defaultModel: info.defaultModel
    };
  });
}

async function healthCheckProvider(provider: ProviderKey): Promise<ProviderStatus> {
  validateProvider(provider);
  const info = providerInfo[provider];
  if (provider !== "ollama") {
    const secrets = await readSecrets();
    const configured = Boolean(secrets[provider]);
    const accounts = await effectiveAccountsForProvider(provider);
    await syncProviderCooldownFromAccounts(provider, accounts);
    const poolSuffix = poolDetailSuffix(accounts);
    const cooldownUntil = providerCooldownUntil(provider);
    if (cooldownUntil) {
      return {
        provider,
        label: info.label,
        configured,
        status: "unavailable",
        detail: `Cooling down until ${new Date(cooldownUntil).toLocaleTimeString()} after a quota/rate-limit response.${poolSuffix}`,
        defaultModel: info.defaultModel
      };
    }
    return {
      provider,
      label: info.label,
      configured,
      status: configured ? "available" : "not_configured",
      detail: (configured ? "Credential is present. Live API call is permission-gated." : "No provider-level API key is saved.") + poolSuffix,
      defaultModel: info.defaultModel
    };
  }

  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const count = payload.models?.length ?? 0;
    return {
      provider,
      label: info.label,
      configured: true,
      status: "available",
      detail: count === 1 ? "1 local model visible." : `${count} local models visible.`,
      defaultModel: payload.models?.[0]?.name ?? info.defaultModel
    };
  } catch (error) {
    return {
      provider,
      label: info.label,
      configured: true,
      status: "unavailable",
      detail: "Ollama is not running, or not reachable at 127.0.0.1:11434. Start Ollama (or launch the Ollama app), then check again.",
      defaultModel: info.defaultModel
    };
  }
}

async function readProviderSecret(provider: ProviderKey): Promise<string | undefined> {
  const secrets = await readSecrets();
  const secret = secrets[provider];
  if (!secret) {
    const envName = providerEnvNames[provider]?.find((name) => Boolean(process.env[name]));
    return envName ? process.env[envName] : undefined;
  }
  try {
    return decryptSecret(secret);
  } catch {
    return undefined;
  }
}

function splitThinkTaggedOutput(value: string): { output: string; thoughts: string } {
  let output = "";
  let thoughts = "";
  let cursor = 0;
  const tag = /<\/?think>/gi;
  let inThought = false;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(value))) {
    const chunk = value.slice(cursor, match.index);
    if (inThought) thoughts += chunk;
    else output += chunk;
    inThought = !match[0].startsWith("</");
    cursor = match.index + match[0].length;
  }
  const tail = value.slice(cursor);
  if (inThought) thoughts += tail;
  else output += tail;
  return { output: output.trim(), thoughts: thoughts.trim() };
}

function createThinkTagStreamSplitter(onOutput: (delta: string) => void, onThought: (delta: string) => void): { feed: (chunk: string) => void; flush: () => void } {
  let inThought = false;
  let tagBuffer = "";
  const openTag = "<think>";
  const closeTag = "</think>";

  function emitText(text: string): void {
    if (!text) return;
    if (inThought) onThought(text);
    else onOutput(text);
  }

  function handleBufferedTag(): boolean {
    const lower = tagBuffer.toLowerCase();
    if (lower === openTag) {
      inThought = true;
      tagBuffer = "";
      return true;
    }
    if (lower === closeTag) {
      inThought = false;
      tagBuffer = "";
      return true;
    }
    if (openTag.startsWith(lower) || closeTag.startsWith(lower)) return true;
    emitText(tagBuffer);
    tagBuffer = "";
    return true;
  }

  return {
    feed(chunk: string): void {
      for (const char of chunk) {
        if (tagBuffer || char === "<") {
          tagBuffer += char;
          handleBufferedTag();
          continue;
        }
        emitText(char);
      }
    },
    flush(): void {
      if (tagBuffer) emitText(tagBuffer);
      tagBuffer = "";
    }
  };
}

// --- Session attachments -> provider images (backend half only; composer
// attach UI is a separate follow-up round, docs/FABLE_PLANS.md attachments
// note). Strictly additive: every consumer downstream gates on images.length
// > 0, so a run with no attachments is byte-identical to before this existed. ---
const MAX_ATTACHMENT_IMAGES = 4;
// ~4MB of base64 text per image — generous enough for a real reference photo
// while stopping a mistakenly-huge upload from ballooning a single request.
const MAX_ATTACHMENT_BASE64_CHARS = 4 * 1024 * 1024;

/** Normalises SessionRunInput.attachments into provider-ready image payloads.
 *  Defensively strips a `data:<mime>;base64,` prefix even though the contract
 *  promises raw base64 — belt and suspenders for whatever the future composer
 *  UI actually sends. Caps the count and per-image size, and never throws: a
 *  malformed attachment is just dropped rather than failing the run. */
function normaliseAttachmentImages(attachments?: SessionAttachment[]): ProviderImageInput[] {
  if (!attachments || attachments.length === 0) return [];
  const images: ProviderImageInput[] = [];
  try {
    for (const attachment of attachments) {
      if (images.length >= MAX_ATTACHMENT_IMAGES) break;
      try {
        if (!attachment || typeof attachment.dataBase64 !== "string" || !attachment.dataBase64) continue;
        const match = attachment.dataBase64.match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/s);
        const data = match ? match[2] : attachment.dataBase64;
        const mimeType = (match ? match[1] : attachment.mimeType) || "application/octet-stream";
        if (!data || data.length > MAX_ATTACHMENT_BASE64_CHARS) continue;
        images.push({ data, mimeType });
      } catch {
        // Malformed single attachment — drop it, never break the whole run.
      }
    }
  } catch {
    return [];
  }
  return images;
}

/** Short note appended to a stage/chat prompt so the model knows a reference
 *  image is attached, even for providers that end up not receiving the bytes
 *  (e.g. deepseek) — they at least know a reference exists. */
function attachmentNoteFor(count: number): string {
  if (count <= 0) return "";
  return `\n\nThe user attached ${count} reference image${count === 1 ? "" : "s"} as a visual reference; match their style/layout where relevant.`;
}

/** `scope` is the same cancel-scope key used by cancelledScopes/throwIfCancelled
 *  (directiveScopeKey(projectPath)). When present, every fetch this call makes
 *  is registered under an AbortController for that scope so requestSessionCancel
 *  can abort it immediately instead of waiting for the call to finish. Callers
 *  that don't have a scope handy (e.g. the direct metis-providers:invoke IPC,
 *  Manager chat) simply omit it and get byte-identical behaviour to before. */
/** `accountOverride`, when given, is a specific pooled ProviderAccount
 *  (docs/DRILL_PLAN.md Phase 6, §19 phase 2) to invoke through instead of the
 *  provider's classic single-key secret — used by callStageWithFallback's
 *  intra-provider account rotation. It is NOT part of ProviderInvokeInput (the
 *  shared IPC contract), so ordinary callers (direct model test calls, etc.)
 *  are completely unaffected: omitting it reproduces the exact pre-pool
 *  behaviour (readProviderSecret(input.provider) + provider-level cooldown). */
async function invokeProvider(
  input: ProviderInvokeInput,
  stream?: SessionStreamController,
  scope?: string,
  accountOverride?: ProviderAccount
): Promise<ProviderInvokeResult> {
  validateProvider(input.provider);
  if (input.provider === "ollama") {
    const controller = scope ? registerAbortController(scope) : undefined;
    try {
      if (stream) {
        return await invokeOllamaProviderStream(input, stream, controller?.signal);
      }
      const response = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          prompt: input.prompt,
          stream: false,
          // Same shape as the proven gallery vision call (captionViaGenerateEndpoint
          // below): top-level `images: [<base64>, ...]`. Ollama silently ignores
          // this on non-vision models, so it's safe to always include when present.
          ...(input.images && input.images.length > 0 ? { images: input.images.map((image) => image.data) } : {})
        }),
        signal: controller?.signal
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
      const payload = (await response.json()) as {
        response?: string;
        thinking?: string;
        think?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      // Newer Ollama API returns reasoning in a dedicated field; older models
      // (e.g. qwen3) inline it as <think>...</think> in the response text.
      const fieldThoughts = (payload.thinking ?? payload.think ?? "").trim();
      const split = splitThinkTaggedOutput(payload.response ?? "");
      const combinedThoughts = [fieldThoughts, split.thoughts].filter(Boolean).join("\n\n").trim();
      const audit = await appendAudit("info", "provider.invoke", `Ran ${input.model} through Ollama.`, {
        provider: input.provider,
        model: input.model,
        prompt_sha256: sha256(input.prompt)
      });
      const usage =
        typeof payload.prompt_eval_count === "number" && typeof payload.eval_count === "number"
          ? { inputTokens: payload.prompt_eval_count, outputTokens: payload.eval_count }
          : estimateUsage(input.prompt.length, split.output.length);
      return {
        provider: input.provider,
        model: input.model,
        output: split.output,
        thoughts: combinedThoughts || undefined,
        source: "ollama",
        auditId: audit.id,
        usage
      };
    } catch (error) {
      // A Stop-button abort must surface as cancellation, never as a provider
      // failure/placeholder — otherwise callStageWithFallback would treat it
      // as "this model is unavailable" and rotate to the next one.
      if (isAbortError(error)) throw cancellationError();
      const audit = await appendAudit("warning", "provider.invoke", `Ollama invocation failed for ${input.model}.`, {
        provider: input.provider,
        model: input.model,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        provider: input.provider,
        model: input.model,
        output: `Ollama is not running, or ${input.model} is not pulled. Start Ollama (or launch the Ollama app), then run: ollama pull ${input.model}, and send again.`,
        source: "placeholder",
        auditId: audit.id
      };
    } finally {
      if (scope && controller) unregisterAbortController(scope, controller);
    }
  }

  const secret = accountOverride ? await resolveAccountSecret(accountOverride) : await readProviderSecret(input.provider);
  if (!secret) {
    const audit = await appendAudit("warning", "provider.invoke.placeholder", `${providerInfo[input.provider].label} route prepared without a saved API key.`, {
      provider: input.provider,
      model: input.model,
      prompt_sha256: sha256(input.prompt)
      // Deliberately no accountId/key material logged here — see the module
      // header note on never logging secrets.
    });
    return {
      provider: input.provider,
      model: input.model,
      output: "The selected cloud provider is not configured yet. Add the provider key in Settings, then run this route again.",
      source: "placeholder",
      auditId: audit.id
    };
  }

  const cloudController = scope ? registerAbortController(scope) : undefined;
  try {
    const { text: output, usage: reportedUsage } = await invokeCloudProvider(input, secret, cloudController?.signal);
    const audit = await appendAudit("info", "provider.invoke", `Ran ${input.model} through ${providerInfo[input.provider].label}.`, {
      provider: input.provider,
      model: input.model,
      prompt_sha256: sha256(input.prompt)
    });
    if (accountOverride) await recordAccountUsage(accountOverride);
    return {
      provider: input.provider,
      model: input.model,
      output,
      source: input.provider,
      auditId: audit.id,
      usage: reportedUsage ?? estimateUsage(input.prompt.length, output.length)
    };
  } catch (error) {
    if (isAbortError(error)) throw cancellationError();
    if (isQuotaError(error)) {
      // Key POOLS (docs/DRILL_PLAN.md Phase 6): a quota/429 cools down THIS
      // account only, not the whole provider — markAccountCooldown, then
      // resync the legacy per-provider map so health/route-resolution only
      // see the provider as unavailable once every account is cooling.
      if (accountOverride) {
        const until = markAccountCooldown(accountOverride.id, error);
        const siblingAccounts = await effectiveAccountsForProvider(input.provider);
        await syncProviderCooldownFromAccounts(input.provider, siblingAccounts);
        await appendAudit(
          "warning",
          "provider.invoke.cooldown",
          `${providerInfo[input.provider].label} account "${accountOverride.label ?? accountOverride.id}" hit a quota/rate limit — cooling down for ${formatCooldownDuration(until)}.`,
          {
            provider: input.provider,
            model: input.model,
            accountId: accountOverride.id,
            error: error instanceof Error ? error.message : String(error),
            cooldownUntil: new Date(until).toISOString()
          }
        );
      } else {
        const until = markProviderCooldown(input.provider, error);
        await appendAudit("warning", "provider.invoke.cooldown", `${providerInfo[input.provider].label} hit a quota/rate limit — cooling down for ${formatCooldownDuration(until)}.`, {
          provider: input.provider,
          model: input.model,
          error: error instanceof Error ? error.message : String(error),
          cooldownUntil: new Date(until).toISOString()
        });
      }
    }
    const audit = await appendAudit("error", "provider.invoke.error", `${providerInfo[input.provider].label} invocation failed.`, {
      provider: input.provider,
      model: input.model,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      provider: input.provider,
      model: input.model,
      output: `The route was selected, but ${providerInfo[input.provider].label} did not return a live response: ${error instanceof Error ? error.message : String(error)}`,
      source: "placeholder",
      auditId: audit.id
    };
  } finally {
    if (scope && cloudController) unregisterAbortController(scope, cloudController);
  }
}

async function invokeOllamaProviderStream(input: ProviderInvokeInput, stream: SessionStreamController, signal?: AbortSignal): Promise<ProviderInvokeResult> {
  // TTFT instrumentation (DRILL_PLAN E1): requestStart is the moment the model
  // request is about to be sent, so it captures queueing/load time on a cold
  // model too — exactly what the prewarm experiment is meant to shave off.
  const requestStart = Date.now();
  let ttftMs: number | undefined;
  const markFirstToken = (): void => {
    // Guard against double-counting: only the very first observed delta
    // (output or thought, whichever arrives first) sets ttftMs.
    if (ttftMs === undefined) ttftMs = Date.now() - requestStart;
  };
  const response = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      stream: true,
      ...(input.images && input.images.length > 0 ? { images: input.images.map((image) => image.data) } : {})
    }),
    signal
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Ollama did not return a readable stream.");

  let output = "";
  let thoughts = "";
  const splitter = createThinkTagStreamSplitter(
    (delta) => {
      markFirstToken();
      output += delta;
      emitStream(stream, { kind: "message_delta", delta });
    },
    (delta) => {
      markFirstToken();
      thoughts += delta;
      emitStream(stream, { kind: "thought_delta", delta });
    }
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let promptEvalCount: number | undefined;
  let evalCount: number | undefined;
  type OllamaStreamChunk = {
    response?: string;
    thinking?: string;
    think?: string;
    done?: boolean;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const handleChunk = (payload: OllamaStreamChunk): void => {
    const thoughtField = payload.thinking ?? payload.think;
    if (thoughtField) {
      // Newer Ollama API: reasoning arrives as its own field, routed straight
      // to thought_delta instead of through the inline <think> tag splitter.
      markFirstToken();
      thoughts += thoughtField;
      emitStream(stream, { kind: "thought_delta", delta: thoughtField });
    }
    if (payload.response) splitter.feed(payload.response);
    if (typeof payload.prompt_eval_count === "number") promptEvalCount = payload.prompt_eval_count;
    if (typeof payload.eval_count === "number") evalCount = payload.eval_count;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handleChunk(JSON.parse(line) as OllamaStreamChunk);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    handleChunk(JSON.parse(buffer) as OllamaStreamChunk);
  }
  splitter.flush();

  const audit = await appendAudit("info", "provider.invoke", `Streamed ${input.model} through Ollama.`, {
    provider: input.provider,
    model: input.model,
    prompt_sha256: sha256(input.prompt)
  });
  const usage =
    typeof promptEvalCount === "number" && typeof evalCount === "number"
      ? { inputTokens: promptEvalCount, outputTokens: evalCount }
      : estimateUsage(input.prompt.length, output.length);
  return {
    provider: input.provider,
    model: input.model,
    output: output.trim(),
    thoughts: thoughts.trim() || undefined,
    source: "ollama",
    auditId: audit.id,
    usage,
    ttftMs
  };
}

async function invokeCloudProvider(input: ProviderInvokeInput, secret: string, signal?: AbortSignal): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> {
  if (input.provider === "anthropic") {
    // Vision guard: build an image+text content-block message when images are
    // present; any formatting failure falls back to the plain text-only body
    // so an attachment can never break a chat/build call.
    let anthropicMessages: unknown = [{ role: "user", content: input.prompt }];
    if (input.images && input.images.length > 0) {
      try {
        anthropicMessages = [
          {
            role: "user",
            content: [
              ...input.images.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mimeType, data: image.data }
              })),
              { type: "text", text: input.prompt }
            ]
          }
        ];
      } catch {
        anthropicMessages = [{ role: "user", content: input.prompt }];
      }
    }
    const response = await fetchJson<{
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": secret,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 6000,
        messages: anthropicMessages
      }),
      signal
    });
    const text = response.content?.map((part) => part.text).filter(Boolean).join("\n").trim() || "Anthropic returned an empty response.";
    const usage =
      typeof response.usage?.input_tokens === "number" && typeof response.usage?.output_tokens === "number"
        ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
        : undefined;
    return { text, usage };
  }

  if (input.provider === "openai") {
    // Vision guard: the Responses API takes a string `input` for plain text,
    // but a structured input array with input_text/input_image parts when
    // images are attached. Any formatting failure falls back to the original
    // plain-string body.
    let openaiInput: unknown = input.prompt;
    if (input.images && input.images.length > 0) {
      try {
        openaiInput = [
          {
            role: "user",
            content: [
              { type: "input_text", text: input.prompt },
              ...input.images.map((image) => ({
                type: "input_image",
                image_url: `data:${image.mimeType};base64,${image.data}`
              }))
            ]
          }
        ];
      } catch {
        openaiInput = input.prompt;
      }
    }
    const response = await fetchJson<{
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({
        model: input.model,
        input: openaiInput
      }),
      signal
    });
    const text =
      response.output_text?.trim() ||
      response.output?.flatMap((item) => item.content ?? []).map((part) => part.text).filter(Boolean).join("\n").trim() ||
      "OpenAI returned an empty response.";
    const usage =
      typeof response.usage?.prompt_tokens === "number" && typeof response.usage?.completion_tokens === "number"
        ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
        : undefined;
    return { text, usage };
  }

  if (input.provider === "gemini") {
    const model = encodeURIComponent(input.model);
    // Vision guard: append inlineData parts alongside the text part when
    // images are present; any formatting failure falls back to text-only parts.
    let geminiParts: unknown[] = [{ text: input.prompt }];
    if (input.images && input.images.length > 0) {
      try {
        geminiParts = [
          { text: input.prompt },
          ...input.images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))
        ];
      } catch {
        geminiParts = [{ text: input.prompt }];
      }
    }
    const response = await fetchJson<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secret)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: geminiParts }]
      }),
      signal
    });
    const text =
      response.candidates?.flatMap((candidate) => candidate.content?.parts ?? []).map((part) => part.text).filter(Boolean).join("\n").trim() ||
      "Gemini returned an empty response.";
    const usage =
      typeof response.usageMetadata?.promptTokenCount === "number" && typeof response.usageMetadata?.candidatesTokenCount === "number"
        ? { inputTokens: response.usageMetadata.promptTokenCount, outputTokens: response.usageMetadata.candidatesTokenCount }
        : undefined;
    return { text, usage };
  }

  if (input.provider === "deepseek") {
    const model = /r1|reason/i.test(input.model) ? "deepseek-reasoner" : "deepseek-chat";
    const response = await fetchJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: input.prompt }]
      }),
      signal
    });
    const text = response.choices?.map((choice) => choice.message?.content).filter(Boolean).join("\n").trim() || "DeepSeek returned an empty response.";
    const usage =
      typeof response.usage?.prompt_tokens === "number" && typeof response.usage?.completion_tokens === "number"
        ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
        : undefined;
    return { text, usage };
  }

  if (input.provider === "openrouter") {
    const response = await fetchJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "http-referer": "https://github.com/lachydotmcg/metis-orchestrator",
        "x-title": "Metis Orchestrator"
      },
      body: JSON.stringify({
        model: input.model === "auto" ? "openrouter/auto" : input.model,
        messages: [{ role: "user", content: input.prompt }]
      }),
      signal
    });
    const text = response.choices?.map((choice) => choice.message?.content).filter(Boolean).join("\n").trim() || "OpenRouter returned an empty response.";
    const usage =
      typeof response.usage?.prompt_tokens === "number" && typeof response.usage?.completion_tokens === "number"
        ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
        : undefined;
    return { text, usage };
  }

  // NVIDIA NIM and Groq are both OpenAI-chat-schema-compatible — same request/
  // response shape as OpenRouter above, just a different base URL (docs/FABLE_PLANS.md §19).
  if (input.provider === "nvidia") {
    const response = await fetchJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }]
      }),
      signal
    });
    const text = response.choices?.map((choice) => choice.message?.content).filter(Boolean).join("\n").trim() || "NVIDIA NIM returned an empty response.";
    const usage =
      typeof response.usage?.prompt_tokens === "number" && typeof response.usage?.completion_tokens === "number"
        ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
        : undefined;
    return { text, usage };
  }

  if (input.provider === "groq") {
    const response = await fetchJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: input.prompt }]
      }),
      signal
    });
    const text = response.choices?.map((choice) => choice.message?.content).filter(Boolean).join("\n").trim() || "Groq returned an empty response.";
    const usage =
      typeof response.usage?.prompt_tokens === "number" && typeof response.usage?.completion_tokens === "number"
        ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
        : undefined;
    return { text, usage };
  }

  throw new Error(`Live invocation is not implemented for ${input.provider}.`);
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
    throw new ProviderHttpError(
      text || `HTTP ${response.status}`,
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
    );
  }
  return JSON.parse(text) as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Strips <think>...</think> blocks from model output so reasoning never leaks
 *  into extracted files, later stage prompts, or chat markdown. */
function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

const MAX_ASK_USER_QUESTIONS = 4;

/** Parsed `<ask_user>` payload. `question`/`options` are always populated
 *  (from the first entry when the multi form was used) for back-compat with
 *  the original single-question call sites; `questions`, when present, is
 *  the multi-question form (docs/DRILL_PLAN.md B2.3a), capped at
 *  MAX_ASK_USER_QUESTIONS entries. */
interface ParsedAskUserTag {
  question: string;
  options: string[];
  questions?: Array<{ text: string; options: string[]; allowCustom?: boolean }>;
}

/** AskUserQuestion tag scan (docs/FABLE_PLANS.md section 24): looks for
 *  either the single-question form
 *  `<ask_user>{"question":"...","options":[...]}</ask_user>` or the
 *  multi-question form (docs/DRILL_PLAN.md B2.3a)
 *  `<ask_user>{"questions":[{"question"|"text":"...","options":[...],"allowCustom":true}]}</ask_user>`
 *  anywhere in a stage's raw output. Extra questions past
 *  MAX_ASK_USER_QUESTIONS are ignored. Fails soft — malformed JSON or an
 *  empty result just means no question was detected, so the stage output
 *  passes through unchanged. */
function extractAskUserTag(value: string): ParsedAskUserTag | null {
  const match = /<ask_user>([\s\S]*?)<\/ask_user>/i.exec(value);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as { question?: unknown; options?: unknown; questions?: unknown };
    if (Array.isArray(parsed.questions)) {
      const coerced: Array<{ text: string; options: string[]; allowCustom?: boolean }> = [];
      for (const raw of parsed.questions) {
        if (coerced.length >= MAX_ASK_USER_QUESTIONS) break;
        if (!raw || typeof raw !== "object") continue;
        const item = raw as { question?: unknown; text?: unknown; options?: unknown; allowCustom?: unknown };
        const text =
          typeof item.text === "string" ? item.text.trim() : typeof item.question === "string" ? item.question.trim() : "";
        if (!text) continue;
        const options = Array.isArray(item.options) ? item.options.filter((o): o is string => typeof o === "string") : [];
        coerced.push(typeof item.allowCustom === "boolean" ? { text, options, allowCustom: item.allowCustom } : { text, options });
      }
      if (coerced.length === 0) return null;
      return { question: coerced[0].text, options: coerced[0].options, questions: coerced };
    }
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    if (!question) return null;
    const options = Array.isArray(parsed.options) ? parsed.options.filter((item): item is string => typeof item === "string") : [];
    return { question, options };
  } catch {
    return null;
  }
}

/** Removes any <ask_user>...</ask_user> tag from output — used defensively so
 *  a stray tag never leaks into extracted files or the chat transcript. */
function stripAskUserTags(value: string): string {
  return value.replace(/<ask_user>[\s\S]*?<\/ask_user>/gi, "").trim();
}

/** Best-effort token estimate (chars/4) for providers that don't report usage. */
function estimateUsage(promptChars: number, outputChars: number): { inputTokens: number; outputTokens: number; estimated: boolean } {
  return {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: Math.ceil(outputChars / 4),
    estimated: true
  };
}

async function listPermissions(): Promise<PermissionGrant[]> {
  return readStoreValue<PermissionGrant[]>("permissions", []);
}

// --- In-run permission prompts + AskUserQuestion pause/resume plumbing
// (docs/FABLE_PLANS.md section 24). Both mechanisms share the same shape:
// main emits a stream event, registers a resolver keyed by a generated id in
// a module-level Map, and awaits it (with a timeout that resolves to a safe
// default) while the renderer's IPC reply looks the id up and calls the
// resolver. Fails soft everywhere — a destroyed window / dropped stream just
// means the timeout path fires.
const PERMISSION_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const pendingPermissionPrompts = new Map<string, (verdict: PermissionVerdict) => void>();

async function promptForPermission(
  stream: SessionStreamController | undefined,
  scope: InRunPermissionRequest["scope"],
  target: string,
  detail: string
): Promise<PermissionVerdict> {
  if (!stream) return "deny";
  const id = randomUUID();
  const request: InRunPermissionRequest = { id, scope, target, detail };
  emitStream(stream, { kind: "permission_request", request });
  return new Promise<PermissionVerdict>((resolveVerdict) => {
    const timer = setTimeout(() => {
      pendingPermissionPrompts.delete(id);
      resolveVerdict("deny");
    }, PERMISSION_PROMPT_TIMEOUT_MS);
    pendingPermissionPrompts.set(id, (verdict) => {
      clearTimeout(timer);
      pendingPermissionPrompts.delete(id);
      resolveVerdict(verdict);
    });
  });
}

function respondToPermissionPrompt(id: string, verdict: PermissionVerdict): void {
  const resolver = pendingPermissionPrompts.get(id);
  if (resolver) resolver(verdict);
}

const PENDING_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
// Resolver accepts a single string (legacy single-question answer) or a
// string[] aligned with `questions` (multi-question form, docs/DRILL_PLAN.md
// B2.3a). Widened additively — every existing single-answer caller still
// resolves with a plain string and keeps working unchanged.
const pendingUserQuestions = new Map<string, (answer: UserQuestionAnswer) => void>();

/** Pauses awaiting a renderer answer to an AskUserQuestion tag; on timeout,
 *  picks the first option for each question (or a generic default) and
 *  reports that it did so via the returned `timedOut` flag so the caller can
 *  add a timeline line. `questions`, when passed, drives the multi-question
 *  form (docs/DRILL_PLAN.md B2.3a, cap 4) in addition to the legacy
 *  `text`/`options` pair; `answers` in the result is always populated (a
 *  single-element array for the legacy path) so callers can treat both
 *  uniformly, while `answer` keeps returning just the first one for
 *  back-compat. */
async function promptUserQuestion(
  stream: SessionStreamController | undefined,
  text: string,
  options: string[],
  questions?: Array<{ text: string; options: string[]; allowCustom?: boolean }>
): Promise<{ answer: string; answers: string[]; timedOut: boolean }> {
  const fallbackAnswer = options[0] ?? "(no preference given — use your best judgement)";
  const fallbackAnswers =
    questions && questions.length > 0
      ? questions.map((q) => q.options[0] ?? "(no preference given — use your best judgement)")
      : [fallbackAnswer];
  if (!stream) return { answer: fallbackAnswer, answers: fallbackAnswers, timedOut: false };
  const id = randomUUID();
  const question: UserQuestionRequest =
    questions && questions.length > 0 ? { id, text, options, questions } : { id, text, options };
  emitStream(stream, { kind: "user_question", question });
  return new Promise((resolveAnswer) => {
    const timer = setTimeout(() => {
      pendingUserQuestions.delete(id);
      resolveAnswer({ answer: fallbackAnswer, answers: fallbackAnswers, timedOut: true });
    }, PENDING_QUESTION_TIMEOUT_MS);
    pendingUserQuestions.set(id, (answer) => {
      clearTimeout(timer);
      pendingUserQuestions.delete(id);
      const answers = Array.isArray(answer) ? answer : [answer];
      resolveAnswer({ answer: answers[0] ?? fallbackAnswer, answers, timedOut: false });
    });
  });
}

function respondToUserQuestion(id: string, answer: UserQuestionAnswer): void {
  const resolver = pendingUserQuestions.get(id);
  if (resolver) resolver(answer);
}

async function requestPermission(request: PermissionRequest): Promise<PermissionGrant> {
  const current = await listPermissions();
  const existing = current.find(
    (grant) => grant.scope === request.scope && grant.target === request.target && grant.projectPath === request.projectPath
  );
  if (existing) return existing;
  const grant: PermissionGrant = {
    id: randomUUID(),
    scope: request.scope,
    target: request.target,
    projectPath: request.projectPath,
    note: request.note,
    sourcePackageId: request.sourcePackageId,
    grantedAt: new Date().toISOString()
  };
  await writeStoreValue("permissions", [...current, grant]);
  await appendAudit("info", "permission.grant", `Granted ${request.scope} for ${request.target}.`, request as unknown as Record<string, unknown>);
  return grant;
}

async function revokePermission(id: string): Promise<void> {
  const current = await listPermissions();
  const grant = current.find((item) => item.id === id);
  await writeStoreValue(
    "permissions",
    current.filter((item) => item.id !== id)
  );
  if (grant) {
    await appendAudit("info", "permission.revoke", `Revoked ${grant.scope} for ${grant.target}.`, { id });
  }
}

/** Local owner profile store (docs/DRILL_PLAN.md B3.2a) — not server auth,
 *  just a per-install identity persisted under the `profile` store key
 *  (metis-store/profile.json). Never throws: any read failure falls back to
 *  a fresh default so the app never blocks on a corrupt/missing file. */
async function readUserProfile(): Promise<UserProfile> {
  try {
    const stored = await readStoreValue<UserProfile | null>("profile", null);
    if (stored) return stored;
    const created: UserProfile = { plan: "byo", createdAt: new Date().toISOString() };
    await writeStoreValue("profile", created);
    return created;
  } catch {
    return { plan: "byo", createdAt: new Date().toISOString() };
  }
}

/** Merges `patch` onto the current profile and persists it, so the renderer
 *  can set name, modelPreference, or onboardedAt independently without
 *  clobbering the rest. Audits only which fields changed, never their values. */
async function writeUserProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
  const current = await readUserProfile();
  const next: UserProfile = { ...current, ...patch };
  await writeStoreValue("profile", next);
  await appendAudit("info", "profile.update", "Profile updated.", { fields: Object.keys(patch) });
  return next;
}

async function readProjectWorkspace(): Promise<ProjectWorkspace | null> {
  const workspace = await readStoreValue<ProjectWorkspace | null>("projectWorkspace", null);
  if (!workspace?.path || !workspace.permissionId) return null;
  return {
    ...workspace,
    path: resolve(workspace.path),
    name: workspace.name || basename(workspace.path) || workspace.path
  };
}

/** Establishes `selectedPath` as THE single writable project workspace: requests the
 *  filesystem.write/project-tools grant for it and persists it under the `projectWorkspace`
 *  store key. This is the one place that grants write access to a folder, shared by every
 *  folder-attach entry point (docs/DRILL_PLAN.md PF1 — "the folder you attach is the writable
 *  project"): the explicit "Choose folder" picker (selectProjectWorkspace) and the "+ Add
 *  folder" workspace-resource attach (addProjectResource) both route through here so a folder
 *  attached either way becomes writable, not just indexed for read-only context. Only one
 *  workspace is writable at a time — attaching a new folder replaces the previous one, matching
 *  the app's existing single-workspace model (see readProjectWorkspace/clearProjectWorkspace). */
async function establishWritableWorkspace(selectedPath: string): Promise<ProjectWorkspace> {
  const grant = await requestPermission({
    scope: "filesystem.write",
    target: "project-tools",
    projectPath: selectedPath,
    note: "Allow Metis project tools to create generated project files inside this folder."
  });
  const workspace: ProjectWorkspace = {
    path: selectedPath,
    name: basename(selectedPath) || selectedPath,
    permissionId: grant.id,
    selectedAt: new Date().toISOString()
  };
  await writeStoreValue("projectWorkspace", workspace);
  await appendAudit("info", "project.workspace.select", `Selected project workspace ${workspace.name}.`, {
    projectPath: workspace.path,
    permissionId: workspace.permissionId
  });
  return workspace;
}

async function selectProjectWorkspace(): Promise<ProjectWorkspaceSelectionResult> {
  const result = await dialog.showOpenDialog({
    title: "Choose a repo or project folder for Metis project tools",
    buttonLabel: "Allow Metis here",
    properties: ["openDirectory", "createDirectory"]
  });
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return { canceled: true };

  const selectedPath = resolve(selected);
  const workspace = await establishWritableWorkspace(selectedPath);
  return { canceled: false, workspace };
}

async function clearProjectWorkspace(): Promise<void> {
  const workspace = await readProjectWorkspace();
  await writeStoreValue<ProjectWorkspace | null>("projectWorkspace", null);
  if (workspace) {
    await appendAudit("info", "project.workspace.clear", `Cleared project workspace ${workspace.name}.`, {
      projectPath: workspace.path,
      permissionId: workspace.permissionId
    });
  }
}

async function listProjectResources(): Promise<ProjectWorkspaceResource[]> {
  return readStoreValue<ProjectWorkspaceResource[]>("projectResources", []);
}

async function addProjectResource(kind: ProjectWorkspaceResource["kind"]): Promise<ProjectWorkspaceResource[]> {
  const result = await dialog.showOpenDialog({
    title: kind === "file" ? "Add files to this Metis workspace" : "Add a folder to this Metis workspace",
    buttonLabel: kind === "file" ? "Add files" : "Add folder",
    properties: kind === "file" ? ["openFile", "multiSelections"] : ["openDirectory", "multiSelections"]
  });
  if (result.canceled || result.filePaths.length === 0) return listProjectResources();

  const current = await listProjectResources();
  const existingPaths = new Set(current.map((item) => resolve(item.path).toLowerCase()));
  const next = [...current];
  for (const rawPath of result.filePaths) {
    const selectedPath = resolve(rawPath);
    if (existingPaths.has(selectedPath.toLowerCase())) continue;
    const grant = await requestPermission({
      scope: "filesystem.read",
      target: `workspace-${kind}`,
      projectPath: selectedPath,
      note: `Allow Metis to index this ${kind} for project memory and session context.`
    });
    next.push({
      id: randomUUID(),
      kind,
      path: selectedPath,
      name: basename(selectedPath) || selectedPath,
      permissionId: grant.id,
      addedAt: new Date().toISOString()
    });
    existingPaths.add(selectedPath.toLowerCase());
  }
  await writeStoreValue("projectResources", next);
  await appendAudit("info", "project.resource.add", `Added ${next.length - current.length} workspace ${kind}${next.length - current.length === 1 ? "" : "s"}.`, {
    kind,
    count: next.length - current.length
  });

  // DRILL_PLAN PF1: attaching a folder (the renderer's "+ Add folder" flow) must make it the
  // writable project, the same as the dedicated "Choose folder" picker — previously this only
  // requested filesystem.read, so a build against an attached-but-never-selected folder fell
  // through resolveWritableProjectWorkspace and silently landed in dataPath("generated-projects")
  // instead. Promote the most recently selected folder from THIS dialog call (last entry in
  // result.filePaths — if multiple were selected at once, the last one wins) to the writable
  // workspace, even if it was already an existing resource (re-selecting reaffirms it as active).
  // Files (kind "file") never affect the writable workspace — only a folder attach does.
  if (kind === "folder" && result.filePaths.length > 0) {
    const promotedPath = resolve(result.filePaths[result.filePaths.length - 1]);
    await establishWritableWorkspace(promotedPath);
  }
  return next;
}

async function removeProjectResource(id: string): Promise<ProjectWorkspaceResource[]> {
  const current = await listProjectResources();
  const resource = current.find((item) => item.id === id);
  const next = current.filter((item) => item.id !== id);
  await writeStoreValue("projectResources", next);
  if (resource) {
    await appendAudit("info", "project.resource.remove", `Removed ${resource.name} from workspace context.`, {
      id,
      path: resource.path
    });
  }
  return next;
}

function sameResolvedPath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

async function resolveWritableProjectWorkspace(requestedPath?: string): Promise<ProjectWorkspace | null> {
  const workspace = await readProjectWorkspace();
  if (!workspace) return null;
  if (requestedPath && !sameResolvedPath(requestedPath, workspace.path)) return null;

  const grants = await listPermissions();
  const allowed = grants.some(
    (grant) =>
      grant.id === workspace.permissionId &&
      grant.scope === "filesystem.write" &&
      grant.target === "project-tools" &&
      Boolean(grant.projectPath) &&
      sameResolvedPath(grant.projectPath ?? "", workspace.path)
  );
  return allowed ? workspace : null;
}

/** DRILL_PLAN PF1 write-target resolver used by every build/preview call site that used to call
 *  resolveWritableProjectWorkspace(input.projectPath) directly. Now that attaching a folder
 *  (either "Choose folder" or "+ Add folder") always establishes it as the writable workspace
 *  (see establishWritableWorkspace), resolveWritableProjectWorkspace returning null should be
 *  rare — but it can still happen if the write grant was independently revoked (Settings >
 *  Permissions) or the workspace was cleared while a folder resource stayed attached. In that
 *  edge case, this falls back to the most recently attached folder resource (by addedAt) rather
 *  than letting the caller silently redirect into dataPath("generated-projects") — a folder that
 *  is still attached must never be shadowed by the app-managed scratch folder. Only when there is
 *  truly nothing attached (no workspace AND no folder resources) does this return null, which
 *  preserves the existing app-managed fallback + warning for that case. When `requestedPath` is
 *  given, the fallback only considers a resource whose path matches it, so this never hijacks an
 *  explicit, unrelated path request. */
async function resolveActiveProjectWorkspace(requestedPath?: string): Promise<ProjectWorkspace | null> {
  const writable = await resolveWritableProjectWorkspace(requestedPath);
  if (writable) return writable;

  const resources = await listProjectResources();
  const folderResources = resources.filter((resource) => resource.kind === "folder");
  if (folderResources.length === 0) return null;

  const candidate = requestedPath
    ? folderResources.find((resource) => sameResolvedPath(resource.path, requestedPath))
    : folderResources[folderResources.length - 1];
  if (!candidate) return null;

  return establishWritableWorkspace(candidate.path);
}

/** Resolves the effective five-mode permission for a session run, preferring
 *  `permissionMode` and falling back to the old three-level `permissionLevel`
 *  for back-compat (docs/FABLE_PLANS.md section 24): restricted -> ask,
 *  standard -> auto, trusted -> auto. Defaults to "auto" (previous behavior). */
function resolvePermissionMode(input: Pick<SessionRunInput, "permissionMode" | "permissionLevel">): PermissionMode {
  if (input.permissionMode) return input.permissionMode;
  if (input.permissionLevel === "restricted") return "ask";
  return "auto";
}

/** Whether an existing grant covers this scope+target (+projectPath when
 *  given) — used by "auto" mode to decide whether a prompt is even needed. */
async function hasExistingGrant(scope: PermissionRequest["scope"], target: string, projectPath?: string): Promise<boolean> {
  const grants = await listPermissions();
  return grants.some((grant) => grant.scope === scope && grant.target === target && (!projectPath || sameResolvedPath(grant.projectPath ?? "", projectPath)));
}

/** Central gate for a permission-scoped action inside a run, per the five
 *  permission modes (docs/FABLE_PLANS.md section 24):
 *  - "bypass": always proceed, never prompts.
 *  - "auto": proceeds unless there's no existing grant for scope+target, in
 *    which case it prompts (so first use of a new scope still asks once).
 *  - "edits": filesystem.write proceeds without asking; everything else asks.
 *  - "ask": always asks.
 *  - "plan": never proceeds (callers should not reach here in plan mode; the
 *    build pipeline short-circuits earlier — this is a defensive default).
 *  Returns `{ proceed, verdict }` — on "always", a PermissionGrant is written
 *  before returning so future asks in this scope+target are skipped. */
async function gatePermission(args: {
  stream: SessionStreamController | undefined;
  mode: PermissionMode;
  scope: PermissionRequest["scope"];
  target: string;
  projectPath?: string;
  detail: string;
}): Promise<{ proceed: boolean; verdict?: PermissionVerdict }> {
  const { stream, mode, scope, target, projectPath, detail } = args;
  if (mode === "bypass") return { proceed: true };
  if (mode === "plan") return { proceed: false };

  const isEditScope = scope === "filesystem.write";
  let shouldPrompt: boolean;
  if (mode === "ask") shouldPrompt = true;
  else if (mode === "edits") shouldPrompt = !isEditScope;
  else /* auto */ shouldPrompt = !(await hasExistingGrant(scope, target, projectPath));

  if (!shouldPrompt) return { proceed: true };

  const verdict = await promptForPermission(stream, scope, target, detail);
  if (verdict === "deny") return { proceed: false, verdict };
  if (verdict === "always") {
    await requestPermission({ scope, target, projectPath, note: detail });
  }
  return { proceed: true, verdict };
}

function isPathInside(child: string, parent: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  if (sameResolvedPath(childResolved, parentResolved)) return true;
  const parentWithSep = parentResolved.endsWith("\\") || parentResolved.endsWith("/") ? parentResolved : `${parentResolved}\\`;
  return childResolved.toLowerCase().startsWith(parentWithSep.toLowerCase()) || childResolved.toLowerCase().startsWith(`${parentResolved.toLowerCase()}/`);
}

const METIS_FILE_READ_MAX_BYTES = 200_000;

/** Reads a file for the Graph View document viewer (file-node click). SECURITY: only allows
 *  paths inside the currently-granted project workspace (via resolveWritableProjectWorkspace)
 *  or inside a granted project resource (filesystem.read grant from addProjectResource) —
 *  anything else is rejected before touching disk. Caps content to keep IPC payloads small and
 *  appends a truncation note rather than silently cutting content off. */
/** Shared security guard for the Graph View document viewer's file IPCs (read + write):
 *  resolves the path and checks it sits inside either the currently-granted project workspace
 *  (via resolveWritableProjectWorkspace's grant shape — filesystem.write on "project-tools") or
 *  inside a granted project resource (filesystem.read grant from addProjectResource). Both
 *  readMetisFile and writeMetisFile call this exact same check so the write path can never be
 *  looser than read. Returns the resolved absolute target on success, throws otherwise. */
async function assertMetisFilePathAllowed(rawPath: string): Promise<string> {
  if (!rawPath || typeof rawPath !== "string") throw new Error("A file path is required.");
  const target = resolve(rawPath);

  const workspace = await readProjectWorkspace();
  const workspaceGrants = await listPermissions();
  const workspaceAllowed =
    Boolean(workspace) &&
    workspaceGrants.some(
      (grant) =>
        grant.id === workspace!.permissionId &&
        grant.scope === "filesystem.write" &&
        grant.target === "project-tools" &&
        Boolean(grant.projectPath) &&
        sameResolvedPath(grant.projectPath ?? "", workspace!.path)
    ) &&
    isPathInside(target, workspace!.path);

  let resourceAllowed = false;
  if (!workspaceAllowed) {
    const resources = await listProjectResources();
    resourceAllowed = resources.some((resource) => {
      if (!workspaceGrants.some((grant) => grant.id === resource.permissionId && grant.scope === "filesystem.read")) return false;
      if (resource.kind === "file") return sameResolvedPath(resource.path, target);
      return isPathInside(target, resource.path);
    });
  }

  if (!workspaceAllowed && !resourceAllowed) {
    throw new Error("This file is outside the permitted project workspace or resources.");
  }

  return target;
}

async function readMetisFile(rawPath: string): Promise<MetisFileReadResult> {
  const target = await assertMetisFilePathAllowed(rawPath);

  let fileStat;
  try {
    fileStat = await stat(target);
  } catch {
    throw new Error("File not found.");
  }
  if (!fileStat.isFile()) throw new Error("Not a file.");

  const raw = await readFile(target, "utf8");
  const truncated = raw.length > METIS_FILE_READ_MAX_BYTES;
  const content = truncated ? `${raw.slice(0, METIS_FILE_READ_MAX_BYTES)}\n\n[truncated — file exceeds ${METIS_FILE_READ_MAX_BYTES.toLocaleString()} characters]` : raw;

  return { path: target, name: basename(target), content, truncated };
}

/** Writes back the Graph View document viewer's editable panel (Obsidian-style edit/save).
 *  SECURITY: runs the identical permitted-root check as readMetisFile via
 *  assertMetisFilePathAllowed — a file that isn't readable through the graph viewer can't be
 *  written through it either. Caps content to the same size limit as read (so a save can never
 *  smuggle in more than the viewer could ever show), rejects writing over a directory, and never
 *  throws out of the IPC handler — failures come back as `{ ok: false, error }` so the renderer
 *  can show them inline instead of an unhandled rejection. */
async function writeMetisFile(rawPath: string, content: string): Promise<MetisFileWriteResult> {
  try {
    if (typeof content !== "string") return { ok: false, error: "No content to save." };
    if (content.length > METIS_FILE_READ_MAX_BYTES) {
      return { ok: false, error: `File exceeds the ${METIS_FILE_READ_MAX_BYTES.toLocaleString()}-character edit limit.` };
    }
    const target = await assertMetisFilePathAllowed(rawPath);

    try {
      const existing = await stat(target);
      if (!existing.isFile()) return { ok: false, error: "Not a file." };
    } catch {
      // File not existing yet is fine — write will create it inside a permitted root.
    }

    await writeFile(target, content, "utf8");
    await appendAudit("info", "files.write", `Saved edits to ${basename(target)}.`, { path: target, chars: content.length });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const METIS_FILE_MAX_CHARS = 6000;

/** Reads `METIS.md` from a project root (Claude Code's CLAUDE.md, for Metis) so
 *  it can be injected as standing instructions into every stage prompt. One
 *  disk read per run — no cache, no watcher. */
async function loadProjectMetisFile(projectPath?: string): Promise<{ content: string; chars: number } | null> {
  if (!projectPath) return null;
  const root = resolve(projectPath);
  let target = join(root, "METIS.md");
  if (!(await exists(target))) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const match = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "metis.md");
      if (!match) return null;
      target = join(root, match.name);
    } catch {
      return null;
    }
  }
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const truncated = trimmed.length > METIS_FILE_MAX_CHARS ? `${trimmed.slice(0, METIS_FILE_MAX_CHARS)}\n[truncated]` : trimmed;
  return { content: truncated, chars: trimmed.length };
}

function metisFilePromptBlock(metisFile: { content: string; chars: number } | null): string {
  if (!metisFile) return "";
  return `Project instructions from METIS.md (follow these; the user's explicit request always outranks these instructions):\n${metisFile.content}\n\n---\n`;
}

const snapshotIgnoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "dist-electron",
  "build",
  "node_modules",
  "out",
  ".cache",
  ".vite"
]);

async function snapshotCurrentProject(): Promise<ProjectSnapshot | null> {
  const workspace = await readProjectWorkspace();
  if (!workspace) return null;
  return buildProjectSnapshot(workspace.path);
}

async function buildProjectSnapshot(rootPath: string): Promise<ProjectSnapshot> {
  const root = resolve(rootPath);
  const warnings: string[] = [];
  const files: ProjectSnapshotFile[] = [];
  const totals = { files: 0, directories: 0 };

  async function scan(dir: string, depth: number): Promise<void> {
    if (files.length >= 80 || depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Could not read ${relativeProjectPath(root, dir)}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const sorted = entries
      .filter((entry) => !entry.name.startsWith(".DS_Store"))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (files.length >= 80) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".github") continue;
      const fullPath = join(dir, entry.name);
      const relativePath = relativeProjectPath(root, fullPath);
      if (entry.isDirectory()) {
        totals.directories += 1;
        if (snapshotIgnoredDirs.has(entry.name)) continue;
        files.push({ path: relativePath, kind: "directory" });
        await scan(fullPath, depth + 1);
      } else if (entry.isFile()) {
        totals.files += 1;
        if (!isSnapshotUsefulFile(entry.name)) continue;
        let size: number | undefined;
        try {
          size = (await stat(fullPath)).size;
        } catch {
          size = undefined;
        }
        files.push({ path: relativePath, kind: "file", bytes: size });
      }
    }
  }

  await scan(root, 0);
  if (files.length >= 80) warnings.push("Snapshot capped at 80 entries to keep chat context small.");

  const packageInfo = await readPackageInfo(root);
  return {
    rootPath: root,
    rootName: basename(root) || root,
    generatedAt: new Date().toISOString(),
    packageManager: await detectPackageManager(root),
    scripts: packageInfo.scripts,
    dependencies: packageInfo.dependencies,
    files,
    totals,
    warnings
  };
}

function relativeProjectPath(root: string, path: string): string {
  return path.slice(root.length).replace(/^[\\/]/, "").replaceAll("\\", "/") || ".";
}

function isSnapshotUsefulFile(name: string): boolean {
  if (/\.(png|jpe?g|gif|webp|ico|mp4|mov|zip|7z|rar|exe|dll|bin|lock)$/i.test(name)) return false;
  return true;
}

async function detectPackageManager(root: string): Promise<ProjectSnapshot["packageManager"]> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "bun.lockb"))) return "bun";
  if (await exists(join(root, "package-lock.json")) || (await exists(join(root, "package.json")))) return "npm";
  return undefined;
}

async function readPackageInfo(root: string): Promise<{ scripts: string[]; dependencies: string[] }> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: Object.keys(parsed.scripts ?? {}).slice(0, 16),
      dependencies: [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})].slice(0, 24)
    };
  } catch {
    return { scripts: [], dependencies: [] };
  }
}

// Bug L4a: the old framing ("Project snapshot:" followed by a plain data
// dump) reads as an implicit instruction to describe the snapshot, so a
// trivial "Test" message got answered with a project-structure narration
// instead of a real reply. This is now framed explicitly as silent
// background context — never the answer itself — while keeping the same
// data available for turns that actually ask about the project.
function snapshotPromptContext(snapshot?: ProjectSnapshot): string {
  if (!snapshot) return "";
  const scripts = snapshot.scripts.length ? snapshot.scripts.join(", ") : "none detected";
  const deps = snapshot.dependencies.length ? snapshot.dependencies.slice(0, 12).join(", ") : "none detected";
  const files = snapshot.files.slice(0, 30).map((file) => `${file.kind === "directory" ? "dir" : "file"}:${file.path}`).join("\n");
  return [
    "This is silent background context about the user's selected project folder, for your reference only — never describe, summarise, list, or acknowledge this snapshot unless the user's message is actually asking about the project or its files. Answer the user's message directly first; only draw on these details when they help answer it.",
    `- Root: ${snapshot.rootName}`,
    `- Package manager: ${snapshot.packageManager ?? "unknown"}`,
    `- Scripts: ${scripts}`,
    `- Dependencies: ${deps}`,
    "- Files:",
    files || "none"
  ].join("\n");
}

function registryDefaultState(): RegistryState {
  return {
    sourceUrl: METIS_REGISTRY_BASE_URL,
    status: "idle",
    packages: registryFallbackPackages
  };
}

function coerceRegistryPackage(value: unknown, expectedId?: string): RegistryPackage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RegistryPackage>;
  if (!candidate.id || !candidate.kind || !candidate.name || !candidate.version || !candidate.publisher) return undefined;
  if (!REGISTRY_PACKAGE_KINDS.has(candidate.kind as RegistryPackageKind)) return undefined;
  if (expectedId && candidate.id !== expectedId) return undefined;
  return {
    schema_version: "0.1.0",
    id: candidate.id,
    kind: candidate.kind as RegistryPackageKind,
    name: candidate.name,
    version: candidate.version,
    publisher: candidate.publisher,
    description: candidate.description ?? "",
    tags: Array.isArray(candidate.tags) ? candidate.tags.filter((tag): tag is string => typeof tag === "string") : [],
    permissions_requested: Array.isArray(candidate.permissions_requested) ? candidate.permissions_requested : [],
    source_url: candidate.source_url ?? "",
    sha256: candidate.sha256,
    policy_compat: candidate.policy_compat,
    ascii_art: Array.isArray(candidate.ascii_art) ? candidate.ascii_art.filter((line): line is string => typeof line === "string") : undefined,
    images: Array.isArray(candidate.images) ? candidate.images.filter((image): image is string => typeof image === "string") : undefined
  };
}

async function listRegistry(): Promise<RegistryState> {
  return readStoreValue<RegistryState>("registryState", registryDefaultState());
}

/** Fetches `index.json` + each `packages/<id>/manifest.json` from the live
 *  registry, validates minimally, and caches the last good state so offline
 *  launches can still show it (docs/FABLE_PLANS.md section 5). */
async function refreshRegistry(sourceUrl?: string): Promise<RegistryState> {
  const base = (sourceUrl?.trim() || METIS_REGISTRY_BASE_URL).replace(/\/$/, "");

  try {
    const indexResponse = await fetch(`${base}/index.json`);
    if (!indexResponse.ok) throw new Error(`HTTP ${indexResponse.status} fetching index.json`);
    const indexPayload = (await indexResponse.json()) as { packages?: unknown };
    const ids = Array.isArray(indexPayload.packages) ? indexPayload.packages.filter((id): id is string => typeof id === "string") : [];

    const manifests = await Promise.all(
      ids.map(async (id) => {
        try {
          const manifestResponse = await fetch(`${base}/packages/${id}/manifest.json`);
          if (!manifestResponse.ok) return undefined;
          const manifestPayload = await manifestResponse.json();
          return coerceRegistryPackage(manifestPayload, id);
        } catch {
          return undefined;
        }
      })
    );
    const packages = manifests.filter((pkg): pkg is RegistryPackage => Boolean(pkg));

    const state: RegistryState = {
      sourceUrl: base,
      refreshedAt: new Date().toISOString(),
      status: "ok",
      packages
    };
    await writeStoreValue("registryState", state);
    await appendAudit("info", "registry.refresh", `Loaded ${packages.length} registry packages.`, { sourceUrl: base });
    return state;
  } catch (error) {
    const cached = await readStoreValue<RegistryState | undefined>("registryState", undefined);
    const state: RegistryState = {
      sourceUrl: base,
      refreshedAt: new Date().toISOString(),
      status: "offline",
      error: error instanceof Error ? error.message : String(error),
      packages: cached?.packages.length ? cached.packages : registryFallbackPackages
    };
    await writeStoreValue("registryState", state);
    await appendAudit("warning", "registry.refresh", "Registry refresh failed; showing last cached packages.", {
      sourceUrl: base,
      error: state.error
    });
    return state;
  }
}

async function listInstalledPackages(): Promise<RegistryPackage[]> {
  return readStoreValue<RegistryPackage[]>("installedPackages", []);
}

/** Fetches the manifest's `source_url` payload, verifies it against
 *  `manifest.sha256`, writes it into the app-managed packages dir, and grants
 *  the requested permission scopes (docs/FABLE_PLANS.md section 5). */
async function installPackage(id: string): Promise<RegistryPackage[]> {
  const registry = await listRegistry();
  const target = registry.packages.find((item) => item.id === id) ?? registryFallbackPackages.find((item) => item.id === id);
  if (!target) throw new Error(`Package not found: ${id}`);

  let installedPath: string | undefined;
  if (target.source_url && /^https?:\/\//i.test(target.source_url)) {
    const response = await fetch(target.source_url);
    if (!response.ok) throw new Error(`Failed to download ${target.name}: HTTP ${response.status}`);
    const payload = await response.text();
    const digest = sha256(payload);
    if (target.sha256 && digest !== target.sha256) {
      await appendAudit("error", "registry.install.sha-mismatch", `SHA-256 mismatch installing ${target.name}; refused to install.`, {
        id: target.id,
        expected: target.sha256,
        actual: digest
      });
      throw new Error(`SHA-256 mismatch for ${target.name}: refusing to install an unverified package.`);
    }
    const filename = basename(new URL(target.source_url).pathname) || "payload";
    const dir = dataPath("packages", id);
    await mkdir(dir, { recursive: true });
    installedPath = join(dir, filename);
    await writeFile(installedPath, payload, "utf8");
  }

  for (const scope of target.permissions_requested) {
    await requestPermission({
      scope,
      target: target.name,
      note: `Requested by package "${target.name}" (${target.id}).`,
      sourcePackageId: target.id
    });
  }

  const installed = await listInstalledPackages();
  const next = [
    ...installed.filter((item) => item.id !== id),
    {
      ...target,
      installedAt: new Date().toISOString(),
      installedPath
    }
  ];
  await writeStoreValue("installedPackages", next);
  await appendAudit("info", "registry.install", `Installed ${target.name}.`, {
    id: target.id,
    kind: target.kind,
    permissions_requested: target.permissions_requested
  });
  return next;
}

/** Extracts the package id from the legacy note format written by
 *  installPackage before grants carried `sourcePackageId`:
 *  `Requested by package "<name>" (<id>).` Returns undefined for
 *  user-created or otherwise non-package grants. */
function grantSourcePackageId(grant: PermissionGrant): string | undefined {
  if (grant.sourcePackageId) return grant.sourcePackageId;
  const match = grant.note?.match(/^Requested by package ".*" \((.+)\)\.$/);
  return match ? match[1] : undefined;
}

async function uninstallPackage(id: string): Promise<RegistryPackage[]> {
  const installed = await listInstalledPackages();
  const target = installed.find((item) => item.id === id);
  if (target?.installedPath) {
    try {
      await rm(dirname(target.installedPath), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; uninstall still proceeds.
    }
  }
  const next = installed.filter((item) => item.id !== id);
  await writeStoreValue("installedPackages", next);

  // Revoke package-originated permission grants for scopes this package
  // requested, once no remaining installed package still needs them. The
  // dedupe in requestPermission means a shared scope's single grant stays
  // tagged with whichever package installed first, so the departing LAST
  // requester takes the grant with it even if it isn't the tagged owner —
  // provided that tagged owner is itself no longer installed.
  if (target) {
    const requestedScopes = new Set(target.permissions_requested);
    const remainingScopes = new Set(next.flatMap((pkg) => pkg.permissions_requested));
    const remainingIds = new Set(next.map((pkg) => pkg.id));
    const grants = await listPermissions();
    const revokable = grants.filter((grant) => {
      const source = grantSourcePackageId(grant);
      if (!source) return false; // user-created / non-package grant: never touch
      if (!requestedScopes.has(grant.scope)) return false; // this package never requested it
      if (remainingScopes.has(grant.scope)) return false; // another installed package still needs it
      return source === id || !remainingIds.has(source); // tagged owner is us, or already gone
    });
    for (const grant of revokable) {
      await revokePermission(grant.id);
    }
    if (revokable.length > 0) {
      await appendAudit("info", "registry.uninstall.revoked", `Revoked ${revokable.length} permission grant(s) from ${target.name}.`, {
        id,
        scopes: revokable.map((grant) => grant.scope)
      });
    }
  }

  await appendAudit("info", "registry.uninstall", `Uninstalled ${id}.`, { id });
  return next;
}

/** Shape of an installed MCP package's mcp.json (docs/DRILL_PLAN.md Phase 4,
 *  MCP client wiring phase 1). Only the first server entry in `mcpServers` is
 *  probed — multi-server bundles are out of scope for this round. */
type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McpServersFile = { mcpServers?: Record<string, McpServerConfig> };

/** Minimal newline-delimited JSON-RPC 2.0 client over a child process's
 *  stdio, used only to drive the initialize -> initialized -> tools/list
 *  handshake in probeMcpServer. Buffers stdout, splits on "\n", and resolves
 *  pending requests by matching the "id" field. */
class McpStdioClient {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();

  constructor(private readonly child: import("node:child_process").ChildProcessWithoutNullStreams | import("node:child_process").ChildProcess) {
    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Non-JSON line (server log noise on stdout) - ignore.
      }
      if (typeof message?.id === "number" && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "MCP server returned an error"));
        else waiter.resolve(message.result);
      }
      // Notifications / requests from the server are ignored - not needed for a probe.
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin?.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    const payload = { jsonrpc: "2.0", method, params };
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  rejectAllPending(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

/** Spawns an installed MCP server over stdio, performs the JSON-RPC
 *  initialize -> initialized -> tools/list handshake, and reports its tools
 *  (docs/DRILL_PLAN.md Phase 4, MCP client wiring phase 1). This is a
 *  read-only capability probe: no tool is ever invoked. Never throws - every
 *  failure path (missing package, spawn error, timeout, malformed response)
 *  resolves to `{ ok: false, error }`, and the child process is always killed
 *  before returning. */
async function probeMcpServer(installedPackageId: string): Promise<McpProbeResult> {
  const installed = await listInstalledPackages();
  const pkg = installed.find((item) => item.id === installedPackageId);
  if (!pkg) {
    return { ok: false, error: `No installed package with id "${installedPackageId}".` };
  }
  if (pkg.kind !== "mcp") {
    return { ok: false, error: `Package "${pkg.name}" is not an MCP package.` };
  }
  if (!pkg.installedPath) {
    return { ok: false, error: `Package "${pkg.name}" has no installed mcp.json path.` };
  }

  let config: McpServersFile;
  try {
    const raw = await readFile(pkg.installedPath, "utf8");
    config = JSON.parse(raw) as McpServersFile;
  } catch (err) {
    return { ok: false, error: `Failed to read/parse mcp.json: ${(err as Error).message}` };
  }

  const entries = Object.entries(config.mcpServers ?? {});
  if (entries.length === 0) {
    return { ok: false, error: "mcp.json has no entries under mcpServers." };
  }
  const [serverName, serverConfig] = entries[0];
  if (!serverConfig?.command) {
    return { ok: false, error: `Server "${serverName}" has no command.` };
  }

  const spawnEnv = { ...process.env, ...(serverConfig.env ?? {}) };
  const args = serverConfig.args ?? [];

  const trySpawn = (useShell: boolean) =>
    spawn(serverConfig.command, args, {
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true
    });

  const result = await new Promise<McpProbeResult>((resolveProbe) => {
    let settled = false;
    let stderrTail = "";
    let client: McpStdioClient | undefined;
    let currentChild: ReturnType<typeof trySpawn> | undefined;
    let retried = false;

    const timer = setTimeout(() => {
      finish({ ok: false, error: "MCP probe timed out after 20s." });
    }, 20_000);

    const finish = (outcome: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.rejectAllPending(new Error("Probe finished"));
      if (currentChild) {
        try {
          currentChild.removeAllListeners();
          currentChild.stdout?.removeAllListeners();
          currentChild.stderr?.removeAllListeners();
          if (!currentChild.killed) currentChild.kill();
        } catch {
          // Best-effort - nothing more we can do if kill itself throws.
        }
      }
      resolveProbe(outcome);
    };

    // Attaches all listeners for one spawn attempt. On Windows, a bare "npx"
    // spawn can ENOENT even when npx.cmd is on PATH (Node's spawn doesn't
    // resolve .cmd shims without shell:true) - retried once with shell:true
    // before giving up.
    const attempt = (useShell: boolean) => {
      const child = trySpawn(useShell);
      currentChild = child;
      stderrTail = "";

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });

      child.once("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (!retried && err.code === "ENOENT" && process.platform === "win32" && !useShell) {
          retried = true;
          try {
            child.removeAllListeners();
            child.stdout?.removeAllListeners();
            child.stderr?.removeAllListeners();
          } catch {
            // ignore
          }
          attempt(true);
          return;
        }
        finish({ ok: false, error: `Failed to spawn MCP server: ${err.message}` });
      });

      child.once("exit", (code, signal) => {
        if (!settled) {
          finish({
            ok: false,
            error: `MCP server exited before handshake completed (code ${code ?? "null"}, signal ${signal ?? "null"}).${stderrTail ? ` stderr: ${stderrTail.slice(-500)}` : ""}`
          });
        }
      });

      client = new McpStdioClient(child);

      (async () => {
        try {
          await client!.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "metis", version: app.getVersion() }
          });
          client!.notify("notifications/initialized", {});
          const toolsResult = await client!.request("tools/list", {});
          const rawTools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
          const tools: McpTool[] = rawTools
            .filter((tool: unknown) => tool && typeof (tool as { name?: unknown }).name === "string")
            .map((tool: { name: string; description?: string }) => ({
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : undefined
            }));
          finish({ ok: true, serverName, tools });
        } catch (err) {
          if (!settled) finish({ ok: false, error: `MCP handshake failed: ${(err as Error).message}` });
        }
      })();
    };

    attempt(process.platform === "win32" && /^npx(\.cmd)?$/i.test(serverConfig.command));
  });

  await appendAudit(result.ok ? "info" : "warning", "mcp.probe", result.ok
    ? `Probed MCP server "${result.serverName}" on package ${pkg.name}: ${result.tools?.length ?? 0} tool(s).`
    : `MCP probe failed for package ${pkg.name}: ${result.error}`, {
    packageId: installedPackageId,
    serverName: result.serverName,
    toolCount: result.tools?.length,
    error: result.error
  });

  return result;
}

function modelCatalogDefaultState(): ModelCatalogState {
  return { sourceUrl: METIS_REGISTRY_BASE_URL, status: "idle", models: [] };
}

/** Validates one raw access-route entry from the wire (schema v2, docs/FABLE_PLANS.md
 *  section 21) — {provider, id} only, both required. */
function isValidAccessRoute(item: unknown): item is ModelAccessRoute {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Partial<ModelAccessRoute>;
  return Boolean(candidate.provider && typeof candidate.provider === "string" && candidate.id && typeof candidate.id === "string");
}

/** Upgrades a v1 catalog entry (bare provider+id, no `access`) to schema v2 by
 *  synthesizing a one-route access list from its own provider/id. v2 entries
 *  that already carry a valid non-empty `access` array pass through unchanged
 *  (docs/FABLE_PLANS.md section 21 — "the registry's models.json evolves
 *  without breaking v1 readers"). */
function upgradeCatalogModelToV2(candidate: CatalogModel): CatalogModel {
  if (Array.isArray(candidate.access) && candidate.access.length > 0 && candidate.access.every(isValidAccessRoute)) {
    return candidate;
  }
  return { ...candidate, access: [{ provider: candidate.provider, id: candidate.id }] };
}

async function listModelCatalog(): Promise<ModelCatalogState> {
  const state = await readStoreValue<ModelCatalogState>("remoteModelCatalog", modelCatalogDefaultState());
  return { ...state, models: state.models.map(upgradeCatalogModelToV2) };
}

/** Fetches `catalog/models.json` from the live registry on launch and on
 *  registry refresh, caching the result so the model picker keeps its last
 *  known list offline (docs/FABLE_PLANS.md section 14). Accepts both v1 (bare
 *  provider+id) and v2 (`access[]`) entries — see upgradeCatalogModelToV2. */
async function refreshModelCatalog(sourceUrl?: string): Promise<ModelCatalogState> {
  const base = (sourceUrl?.trim() || METIS_REGISTRY_BASE_URL).replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/catalog/models.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { models?: unknown };
    const models = Array.isArray(payload.models)
      ? payload.models
          .filter((item): item is CatalogModel => {
            if (!item || typeof item !== "object") return false;
            const candidate = item as Partial<CatalogModel>;
            if (!candidate.provider || !candidate.id || !candidate.name || (candidate.tier !== "cloud" && candidate.tier !== "local")) return false;
            // access[] is optional on the wire; when present, every entry must be a valid route.
            if (candidate.access !== undefined && !(Array.isArray(candidate.access) && candidate.access.every(isValidAccessRoute))) return false;
            return true;
          })
          .map(upgradeCatalogModelToV2)
      : [];
    const state: ModelCatalogState = { sourceUrl: base, refreshedAt: new Date().toISOString(), status: "ok", models };
    await writeStoreValue("remoteModelCatalog", state);
    return state;
  } catch (error) {
    const cached = await readStoreValue<ModelCatalogState | undefined>("remoteModelCatalog", undefined);
    const state: ModelCatalogState = {
      sourceUrl: base,
      refreshedAt: new Date().toISOString(),
      status: "offline",
      error: error instanceof Error ? error.message : String(error),
      models: cached?.models ?? []
    };
    await writeStoreValue("remoteModelCatalog", state);
    return state;
  }
}

function pulseFeedDefaultState(): PulseFeed {
  return { sourceUrl: METIS_REGISTRY_BASE_URL, status: "idle", changelog: [], community: [], news: [] };
}

async function listPulseFeed(): Promise<PulseFeed> {
  return readStoreValue<PulseFeed>("pulseFeed", pulseFeedDefaultState());
}

/** Fetches `featured.json` from the live registry (same cache-for-offline
 *  pattern as the model catalog) for the Pulse tab (docs/FABLE_PLANS.md section 8). */
async function refreshPulseFeed(sourceUrl?: string): Promise<PulseFeed> {
  const base = (sourceUrl?.trim() || METIS_REGISTRY_BASE_URL).replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/featured.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as Partial<PulseFeed> & { updated?: string };
    const state: PulseFeed = {
      sourceUrl: base,
      refreshedAt: new Date().toISOString(),
      status: "ok",
      updated: payload.updated,
      changelog: Array.isArray(payload.changelog) ? (payload.changelog as PulseFeed["changelog"]) : [],
      community: Array.isArray(payload.community)
        ? payload.community.map((item) => coerceRegistryPackage(item)).filter((pkg): pkg is RegistryPackage => Boolean(pkg))
        : [],
      news: Array.isArray(payload.news) ? (payload.news as PulseFeed["news"]) : [],
      discordInvite: payload.discordInvite
    };
    await writeStoreValue("pulseFeed", state);
    return state;
  } catch (error) {
    const cached = await readStoreValue<PulseFeed | undefined>("pulseFeed", undefined);
    const state: PulseFeed = {
      ...pulseFeedDefaultState(),
      sourceUrl: base,
      refreshedAt: new Date().toISOString(),
      status: "offline",
      error: error instanceof Error ? error.message : String(error),
      changelog: cached?.changelog ?? [],
      community: cached?.community ?? [],
      news: cached?.news ?? [],
      updated: cached?.updated,
      discordInvite: cached?.discordInvite
    };
    await writeStoreValue("pulseFeed", state);
    return state;
  }
}

const METIS_RELEASES_URL = "https://api.github.com/repos/lachydotmcg/metis-orchestrator/releases/latest";

/** Numeric semver-ish compare: splits on "." and compares major/minor/patch as
 *  numbers, left to right. Non-numeric/missing segments read as 0. Returns
 *  true when `latest` is strictly newer than `current`. */
function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = latest.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = current.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(latestParts.length, currentParts.length);
  for (let i = 0; i < len; i += 1) {
    const l = latestParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

/** Titlebar "Update available" badge check (docs follow-up: this is a CHECK +
 *  BADGE + click-through-to-release only. Wiring true auto-download/install
 *  needs electron-updater pointed at published GitHub Releases, which in turn
 *  needs a publish config and a packaged/signed app — none of that exists yet,
 *  so this handler only ever tells the renderer "go look at this release page". */
async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch(METIS_RELEASES_URL, {
      headers: {
        "User-Agent": "metis-orchestrator",
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as { tag_name?: string; html_url?: string; body?: string };
    const rawTag = typeof payload.tag_name === "string" ? payload.tag_name : "";
    const latestVersion = rawTag.replace(/^v/i, "").trim();
    if (!latestVersion) throw new Error("missing tag_name");
    const updateAvailable = isNewerVersion(latestVersion, currentVersion);
    const notes = typeof payload.body === "string" ? payload.body.trim().slice(0, 500) : undefined;
    return {
      updateAvailable,
      currentVersion,
      latestVersion,
      url: typeof payload.html_url === "string" ? payload.html_url : undefined,
      notes
    };
  } catch {
    // Offline, no releases published yet (404), rate-limited, or an unparseable
    // payload — never throw out of the handler, just report "no update".
    return { updateAvailable: false, currentVersion };
  }
}

async function policyCliCandidates(): Promise<string[]> {
  return [
    process.env.METIS_POLICY_CLI,
    resolve(process.cwd(), "..", "metis-policy", "dist", "src", "cli.js"),
    resolve(app.getAppPath(), "..", "metis-policy", "dist", "src", "cli.js")
  ].filter((path): path is string => Boolean(path));
}

async function resolvePolicyCli(): Promise<string | undefined> {
  for (const candidate of await policyCliCandidates()) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function policyProfileCandidates(): Promise<string[]> {
  return [
    process.env.METIS_POLICY_PROFILE,
    dataPath("policy-profile.json"),
    resolve(process.cwd(), "..", "metis-policy", "profile.json"),
    resolve(app.getAppPath(), "..", "metis-policy", "profile.json")
  ].filter((path): path is string => Boolean(path));
}

async function resolvePolicyProfile(explicitPath?: string): Promise<string | undefined> {
  const candidates = explicitPath ? [explicitPath, ...(await policyProfileCandidates())] : await policyProfileCandidates();
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function getPolicyStatus(profilePath?: string): Promise<PolicyStatus> {
  const [cliPath, resolvedProfile] = await Promise.all([resolvePolicyCli(), resolvePolicyProfile(profilePath)]);
  if (!cliPath) {
    return {
      available: false,
      profilePath: resolvedProfile,
      detail: "metis-policy CLI was not found. Build or configure METIS_POLICY_CLI to enable real decisions."
    };
  }
  if (!resolvedProfile) {
    return {
      available: false,
      cliPath,
      detail: "No policy profile was found. Import a Metis leaderboard payload first."
    };
  }
  return {
    available: true,
    cliPath,
    profilePath: resolvedProfile,
    detail: "metis-policy CLI and profile are available."
  };
}

async function decidePolicy(input: PolicyDecisionInput): Promise<PolicyDecisionResult> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Policy decision requires a prompt.");
  }
  const status = await getPolicyStatus(input.profilePath);
  if (!status.available || !status.cliPath || !status.profilePath) {
    await appendAudit("warning", "policy.decide.sample", "Used sample policy decision because metis-policy is not ready.", {
      detail: status.detail,
      prompt_sha256: sha256(prompt)
    });
    return {
      source: "sample",
      decision: sampleDecision,
      warnings: [status.detail]
    };
  }

  const args = [status.cliPath, "decide", "--profile", status.profilePath, "--prompt", prompt, "--json"];
  if (input.preset) args.push("--preset", input.preset);
  if (input.localOnly) args.push("--local-only");
  if (input.cloudOnly) args.push("--cloud-only");
  if (input.strictPrivacy) args.push("--strict-privacy");

  try {
    const { stdout } = await execFileAsync("node", args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    const decision = JSON.parse(stdout) as RouteDecision;
    await appendAudit("info", "policy.decide", `Policy selected ${decision.selected_route.kind} route.`, {
      task_type: decision.task_type,
      route: decision.selected_route,
      profile: status.profilePath,
      prompt_sha256: decision.prompt_profile.prompt_sha256
    });
    return {
      source: "metis-policy-cli",
      decision,
      warnings: decision.warnings
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendAudit("error", "policy.decide.error", "metis-policy decision failed; used sample decision.", {
      error: message,
      prompt_sha256: sha256(prompt)
    });
    return {
      source: "sample",
      decision: sampleDecision,
      warnings: [message]
    };
  }
}

function providerFromRoute(provider: string | undefined, runtime: string | undefined, kind: string): ProviderKey {
  const key = `${provider ?? ""} ${runtime ?? ""} ${kind}`.toLowerCase();
  if (key.includes("anthropic") || key.includes("claude")) return "anthropic";
  if (key.includes("openai") || key.includes("gpt")) return "openai";
  if (key.includes("gemini") || key.includes("google")) return "gemini";
  if (key.includes("deepseek")) return "deepseek";
  if (key.includes("openrouter")) return "openrouter";
  return "ollama";
}

function pipelineNameFor(decision: RouteDecision): string {
  if (decision.task_type === "frontend_design") return "Front End Orchestration Pipeline";
  if (decision.task_type === "coding") return "Coding Orchestration Pipeline";
  if (decision.task_type === "summarisation") return "Summarisation Pipeline";
  if (decision.task_type === "long_context") return "Long Context Retrieval Pipeline";
  if (decision.task_type === "private_sensitive") return "Private Local Pipeline";
  return "General Assistant Pipeline";
}

function pipelineIntentFromPrompt(prompt: string): RouteDecision["task_type"] | null {
  if (/\b(front\s*end|frontend)\s+pipeline\b/i.test(prompt)) return "frontend_design";
  if (/\b(back\s*end|backend)\s+pipeline\b/i.test(prompt)) return "coding";
  if (/\bcoding\s+pipeline\b/i.test(prompt)) return "coding";
  return null;
}

function routeLabelFromPrompt(prompt: string): string | undefined {
  if (/\b(back\s*end|backend)\s+pipeline\b/i.test(prompt)) return "Back End";
  if (/\b(front\s*end|frontend)\s+pipeline\b/i.test(prompt)) return "Front End";
  return undefined;
}

async function previousConversationTaskType(conversationId?: string): Promise<RouteDecision["task_type"] | null> {
  if (!conversationId) return null;
  const conversations = await readConversations();
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return null;
  for (const turn of [...conversation.turns].reverse()) {
    if (turn.role === "assistant" && turn.run?.decision.decision.task_type && turn.run.decision.decision.task_type !== "general_chat") {
      return turn.run.decision.decision.task_type;
    }
  }
  return null;
}

async function previousConversationRouteLabel(conversationId?: string): Promise<string | undefined> {
  if (!conversationId) return undefined;
  const previousRun = await previousConversationRun(conversationId);
  return previousRun?.routeLabel;
}

async function previousConversationRun(conversationId?: string): Promise<SessionRun | null> {
  if (!conversationId) return null;
  const conversations = await readConversations();
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return null;
  for (const turn of [...conversation.turns].reverse()) {
    if (turn.role === "assistant" && turn.run) return turn.run;
  }
  return null;
}

function isAttributionQuestion(prompt: string): boolean {
  return /\b(was that|was it|who responded|who said|which model|what model|backend model|front\s*end model|frontend model|did you|was that you)\b/i.test(prompt);
}

function shouldReusePreviousPipeline(prompt: string): boolean {
  return /\b(it|that|this|the pipeline|same pipeline|ask it|tell it|respond with|say)\b/i.test(prompt) && !pipelineIntentFromPrompt(prompt) && !isAttributionQuestion(prompt);
}

function initialPipelineSteps(pipelineName: string, decision: RouteDecision, includeProjectTools = true, override?: SessionModelOverride): SessionPipelineStep[] {
  if (override) {
    // Pinned model = direct chat: there is no routing decision and no
    // orchestration pipeline running, so the step list shrinks to what
    // actually happens (call the pinned model, write the response) instead
    // of narrating a pipeline that never ran (DRILL_PLAN PF5a — a pinned run
    // used to show "Run Front End Orchestration Pipeline" purely because
    // that's what the auto-router *would* have picked). appendAudit calls
    // elsewhere still record the full trail; this only shrinks the
    // user-visible step list.
    return [
      {
        id: "route",
        label: `Calling ${overrideDisplayLabel(override)} directly`,
        detail: "Direct call to your pinned model, no routing decision to make.",
        status: "pending"
      },
      {
        id: "provider",
        label: "Call selected model",
        detail: `Send the task to ${override.provider} / ${resolveOverrideModel(override)}.`,
        status: "pending"
      },
      {
        id: "finalize",
        label: "Write response",
        detail: "Return the model output and save the audit record.",
        status: "pending"
      }
    ];
  }
  const steps: SessionPipelineStep[] = [
    {
      id: "route",
      label: "Route through Metis Policy",
      detail: "Classify the prompt, score available routes, and select the primary model plus fallback path.",
      status: "pending"
    },
    {
      id: "orchestration",
      label: `Run ${pipelineName}`,
      detail: `Load the route skills, preset, and model path for ${decision.task_type.replace("_", " ")}.`,
      status: "pending"
    },
    {
      id: "provider",
      label: "Call selected model",
      detail: `Send the task to ${decision.selected_route.provider ?? decision.selected_route.runtime ?? decision.selected_route.kind} / ${decision.selected_route.model ?? "auto"}.`,
      status: "pending"
    }
  ];

  if (decision.task_type === "frontend_design" && includeProjectTools) {
    steps.push({
      id: "project-tools",
      label: "Write Project Files",
      detail: "Create the generated frontend files in the app-managed project workspace and prepare a local preview.",
      status: "pending"
    });
  }

  if ((decision.task_type === "frontend_design" && includeProjectTools) || decision.task_type === "coding") {
    steps.push({
      id: "verify",
      label: decision.task_type === "frontend_design" ? "Run Testing Orchestration Pipeline" : "Run Verification Pipeline",
      detail: decision.task_type === "frontend_design" ? "Start the local preview and verify the generated page responds." : "Prepare linting, tests, and file-diff verification.",
      status: "pending"
    });
  }

  steps.push({
    id: "finalize",
    label: "Write response and audit trace",
    detail: "Return the model output with route evidence, warnings, and the saved audit record.",
    status: "pending"
  });

  return steps;
}

function completeStep(step: SessionPipelineStep, auditId?: string): SessionPipelineStep {
  const now = new Date().toISOString();
  return {
    ...step,
    status: "complete",
    startedAt: step.startedAt ?? now,
    completedAt: now,
    auditId
  };
}

/** Shared with the Manager tab's action protocol (see MANAGER_ACTION_KINDS /
 *  extractManagerActions) so a general chat turn can propose the same
 *  owner-approved actions without duplicating the kind list or the format.
 *  Only ever appended when `allowActions` is true (general chat, non-fast-lane
 *  — see the runSession call site) so build stages and trivial fast-lane
 *  turns never pay for or see this instruction. */
function sessionActionProtocolBlock(): string {
  return [
    `You may also PROPOSE actions for the owner to approve — you never execute anything yourself, the owner reviews and approves each one in the UI. Propose actions ONLY when the user clearly wants something done (not for general chat, advice, or discussion). If no action is called for, do not include the block at all.`,
    `To propose actions, end your reply with a fenced block, exactly this shape, after your normal conversational reply:`,
    '```metis-actions\n[ { "kind": "add_todo", "title": "...", "reason": "..." } ]\n```',
    `Rules for the block: it must be the LAST thing in your reply; it must contain a JSON array (even if it has one item); do not add commentary inside or after it. Keep your actual conversational answer above the block, as normal prose.`,
    `Available action kinds and their fields:`,
    `- "run_in_project": { "prompt": string, "projectPath"?: string, "reason"?: string } — projectPath is optional and defaults to the current project workspace.`,
    `- "add_todo": { "title": string, "assignee"?: "manager" | "fable", "reason"?: string } — adds a card to the to-do board.`,
    `- "open_view": { "view": string, "reason"?: string } — view is one of: orchestration, marketplace, gallery, benchmark, todo, routines, graph, session, manager, settings, pulse.`,
    `Every action should carry a short "reason" explaining why you're proposing it. Propose at most a few actions per reply — do not flood the user with proposals.`
  ].join("\n\n");
}

function sessionProviderPrompt(
  prompt: string,
  decision: RouteDecision,
  _pipelineName: string,
  previousRun?: SessionRun | null,
  projectSnapshot?: ProjectSnapshot,
  designSeed?: DesignSeed,
  metisFile?: { content: string; chars: number } | null,
  conversationContext?: string | null,
  knowledgeContext?: string | null,
  allowActions?: boolean
): string {
  const previousSource = previousRun?.providerResult
    ? `Previous response source: ${providerInfo[previousRun.providerResult.provider].label} / ${previousRun.providerResult.model} via ${previousRun.pipelineName}.`
    : previousRun
      ? `Previous response source: ${previousRun.pipelineName}; no live provider result was recorded.`
      : "";
  return [
    knowledgeContext ?? "",
    metisFilePromptBlock(metisFile ?? null),
    conversationContext ? `Recent conversation (for continuity — the newest user request is the task):\n${conversationContext}` : "",
    `You are running inside Metis Orchestrator.`,
    `Task type: ${decision.task_type}.`,
    decision.task_type === "coding" ? `You are the selected Back End/Coding Pipeline model for this turn.` : `You are the selected model for this turn.`,
    previousSource,
    `Answer the user's request directly and concisely.`,
    `You are ONE model. Do not simulate, roleplay, or narrate other models or agents (e.g. "Prompt to Gemini", "Gemini's suggestion", "DeepSeek output"). Do not invent a multi-step pipeline of other models. Just give your own answer.`,
    `Do not dump long plans unless asked; keep it short and ask the user before producing large outputs.`,
    previousSource ? `If the user asks who produced the previous response, answer from the previous response source above and do not claim you personally produced it unless the source is this current model.` : "",
    `If the user asks the pipeline or model to say/respond with an exact token or phrase, output that exact phrase and nothing else.`,
    `Do not explain internal routing, providers, model names, policy decisions, or pipeline steps unless the user explicitly asks for routing details.`,
    `If implementation or verification is needed, describe the concrete artifact or next action without claiming files were created unless Metis attaches project-tool results.`,
    `Never ask the user for a brief, requirements, or say the project is empty. If details are missing, invent tasteful, specific choices yourself (name, copy, palette, content) and state them briefly — you are the creative lead. Do not end with a question asking permission to proceed; proceed.`,
    designSeed ? designSeedPromptLine(designSeed, { explicitStyle: promptHasExplicitStyle(prompt) }) : "",
    snapshotPromptContext(projectSnapshot),
    allowActions ? sessionActionProtocolBlock() : "",
    "",
    prompt
  ].filter(Boolean).join("\n");
}

function shouldRunFrontendTools(prompt: string, decision: RouteDecision): boolean {
  return decision.task_type === "frontend_design" || /\b(front\s*end|frontend|landing page|website|web page|ui|design)\b/i.test(prompt);
}

// Explicit opt-outs and question guards shared by the build-pipeline gate and
// the chat-path project writer, so a pure status/explain question never
// triggers a design seed, project write, or "model did not return complete
// files" warning.
function isBuildOptOut(prompt: string): boolean {
  return /\b(without (generating|creating|building|writing|changing) (anything|any files?|code)|don'?t (build|create|generate|write|touch)|just (tell|show|explain|answer)|no code|status of)\b/i.test(prompt);
}

// Advisory/explanatory asks — "walk me through...", "explain...", "give me a
// skeleton..." — want an ANSWER in chat, not a file-writing build run. These
// prompts often mention a build verb or artifact noun somewhere in the prose
// (e.g. "...helping me design a feature...local-first Electron app...") which
// is exactly what makes them slip past the plain build/edit heuristics: those
// heuristics (hasImperativeBuildIntent, isEditIntent) match a verb or noun
// ANYWHERE in the text, not the actual intent of the sentence. Anchored with
// \b so short substrings inside unrelated words don't trip it.
const ADVISORY_INTENT_RE =
  /\b(?:walk (?:me )?through|talk (?:me )?through|explain|describe|outline|how (?:would|do|should|can) i\b|how to\b|what(?:'s| is| are| should| would) the best\b|give me (?:a|an)\b[\s\S]{0,40}?\b(?:skeleton|example|outline|overview|rundown|starting point|sketch|idea)\b|help me (?:understand|think|plan|design)\b|should i\b)/i;

// A prompt that OPENS with an imperative build verb aimed at the assistant
// ("build me a landing page", "create the app", "make me a website") is an
// unambiguous, direct build/edit order even if it also contains
// advisory-sounding phrasing later on ("...walk me through what you did").
// This is deliberately narrower than hasImperativeBuildIntent, which matches
// a build verb and an artifact noun anywhere in the prompt (so it already
// fires, incorrectly, on prose like "...helping me design a feature...
// Electron app..." even though nothing there is a direct order) — here we
// only look at how the prompt actually opens, which is a much stronger and
// less ambiguous signal that "build/change my project" is the primary ask.
function hasStrongImperativeBuildLead(prompt: string): boolean {
  return /^\s*(?:build|make|create|design|generate|develop|scaffold|implement)\b(?:\s+(?:me|us))?\s+(?:a|an|the)\b/i.test(prompt);
}

function isBuildQuestionGuard(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^\s*(what|which|who|whose|when|where|why|how|did|was|were|is|are|does|do)\b/i.test(trimmed)) return true;
  if (/\?\s*$/.test(trimmed) && /\b(asked|created|built|made|generated|wrote)\b/i.test(trimmed)) return true;
  // Advisory ask ("walk me through...", "give me a skeleton...") wins UNLESS
  // the prompt itself opens with a direct imperative build order — in which
  // case the direct order is the primary ask and normal build/edit routing
  // applies.
  if (ADVISORY_INTENT_RE.test(trimmed) && !hasStrongImperativeBuildLead(trimmed)) return true;
  return false;
}

function shouldCreateFrontendProject(prompt: string, decision: RouteDecision): boolean {
  if (isBuildOptOut(prompt)) return false;
  if (isBuildQuestionGuard(prompt)) return false;
  if (!shouldRunFrontendTools(prompt, decision)) return false;
  if (/\b(route|routing|test|try|probe|call|can you use|are you able)\b/i.test(prompt)) return false;
  return /\b(build|make|create|design|implement|generate|landing page|website|web page|frontend|front\s*end|ui)\b/i.test(prompt);
}

function shouldForceClaudeFrontendRoute(prompt: string): boolean {
  return /\b(claude|anthropic|sonnet|opus)\b/i.test(prompt) && /\b(front\s*end|frontend|ui|design|website|landing page)\b/i.test(prompt);
}

function applySessionRouteOverrides(prompt: string, decision: RouteDecision, routeContext?: RouteDecision["task_type"] | null): RouteDecision {
  const explicitPipeline = pipelineIntentFromPrompt(prompt);
  const task_type = explicitPipeline ?? routeContext ?? (shouldRunFrontendTools(prompt, decision) ? "frontend_design" : decision.task_type);
  if (shouldForceClaudeFrontendRoute(prompt)) {
    return {
      ...decision,
      task_type: "frontend_design",
      selected_route: {
        kind: "cloud",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        availability: "available"
      },
      fallback_routes: [decision.selected_route, ...(decision.fallback_routes ?? [])],
      reason: "User explicitly requested Claude/Sonnet for a frontend-design route."
    };
  }
  if (task_type === "coding" && decision.task_type !== "coding") {
    return {
      ...decision,
      task_type,
      selected_route: {
        kind: "cloud",
        provider: "deepseek",
        model: "deepseek-chat",
        availability: "available"
      },
      fallback_routes: [decision.selected_route, ...(decision.fallback_routes ?? [])],
      reason: "User requested or continued the Back End/Coding pipeline."
    };
  }
  return task_type === decision.task_type ? decision : { ...decision, task_type };
}

function visibleBackendWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => !/proxy evidence|quality for .* uses proxy|needs judge or human visual validation/i.test(warning));
}

function frontendTitleFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/\b(build|make|create|design|me|a|an|the|polished|front\s*end|frontend|landing page|website|web page|ui)\b/gi, " ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = cleaned.split(" ").slice(0, 5).join(" ");
  return title ? title.replace(/\b\w/g, (match) => match.toUpperCase()) : "Metis Generated Landing Page";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated-project";
}

type GeneratedFile = { path: string; content: string };

const generatedFileExtensions = new Set([
  ".css",
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml"
]);

const skippedCodeFenceLanguages = new Set([
  "bash",
  "cmd",
  "console",
  "diff",
  "dos",
  "log",
  "markdown",
  "md",
  "output",
  "plaintext",
  "powershell",
  "ps",
  "ps1",
  "sh",
  "shell",
  "text"
]);

function safeRelativeFilePath(candidate: string): string | null {
  const cleaned = candidate
    .trim()
    .replace(/^["'`]+|["'`,:]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!cleaned || cleaned.includes("\0") || cleaned.includes(":") || cleaned.startsWith("/") || cleaned.includes("..")) return null;
  const extension = extname(cleaned).toLowerCase();
  if (!generatedFileExtensions.has(extension)) return null;
  return cleaned;
}

function lastFilenameHint(text: string): string | null {
  const patterns = [
    /`([^`\n]+\.[a-zA-Z0-9]{1,12})`/g,
    /(?:^|\n)\s*(?:file|path|filename)\s*:\s*([^\s`"'<>]+\.[a-zA-Z0-9]{1,12})\s*:?$/gim,
    /(?:^|\n)\s*([A-Za-z0-9_./@-]+\.[a-zA-Z0-9]{1,12})\s*:?$/gim
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (let index = matches.length - 1; index >= 0; index--) {
      const safe = safeRelativeFilePath(matches[index][1]);
      if (safe) return safe;
    }
  }
  return null;
}

function inferFilename(lang: string, code: string): string | null {
  const normalized = lang.toLowerCase();
  if (normalized === "html" || /<!doctype html|<html[\s>]/i.test(code)) return "index.html";
  if (normalized === "css") return "styles.css";
  if (normalized === "json") return "package.json";
  if (normalized === "svg") return "asset.svg";
  if (normalized === "ts" || normalized === "typescript") return "index.ts";
  if (normalized === "tsx") return "src/App.tsx";
  if (normalized === "jsx") return "src/App.jsx";
  if (normalized === "py" || normalized === "python") return "app.py";
  if (normalized === "js" || normalized === "javascript" || normalized === "mjs" || normalized === "cjs") {
    return /\b(require\(|express|app\.listen|module\.exports|createServer)\b/.test(code) ? "server.js" : "script.js";
  }
  return null;
}

function extractHtmlDocument(text: string): string | null {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  const tail = text.slice(start);
  const end = /<\/html\s*>/i.exec(tail);
  if (!end) return null;
  return tail.slice(0, end.index + end[0].length).trim();
}

function isCompletePreviewHtml(path: string, content: string): boolean {
  if (basename(path).toLowerCase() !== "index.html") return true;
  return /<html[\s>]/i.test(content) && /<body[\s>]/i.test(content) && /<\/body\s*>/i.test(content) && /<\/html\s*>/i.test(content);
}

function withPreviewMarker(path: string, content: string): string {
  if (basename(path).toLowerCase() !== "index.html") return content;
  if (/data-metis-preview|metisPreview/.test(content)) return content;
  if (/<body\b/i.test(content)) {
    return content.replace(/<body\b([^>]*)>/i, (match, attrs: string) =>
      /data-metis-preview=/i.test(attrs) ? match : `<body${attrs} data-metis-preview="ready">`
    );
  }
  return `${content}\n<script>window.metisPreview = true;</script>\n`;
}

// A fence language token must be consistent with a hinted filename — a `css`
// fence can't belong to a `.js` hint picked up from surrounding prose.
function fenceLangMatchesPath(lang: string, path: string): boolean {
  if (!lang) return true;
  const ext = extname(path).toLowerCase();
  const groups: Record<string, string[]> = {
    css: [".css"],
    html: [".html", ".htm"],
    json: [".json", ".webmanifest"],
    js: [".js", ".mjs", ".cjs"],
    javascript: [".js", ".mjs", ".cjs"],
    mjs: [".mjs", ".js"],
    cjs: [".cjs", ".js"],
    ts: [".ts"],
    typescript: [".ts"],
    tsx: [".tsx"],
    jsx: [".jsx"],
    svg: [".svg"],
    xml: [".xml", ".svg"],
    yaml: [".yaml", ".yml"],
    yml: [".yaml", ".yml"],
    py: [".py"],
    python: [".py"]
  };
  const allowed = groups[lang];
  if (!allowed) return true;
  return allowed.includes(ext);
}

function extractGeneratedFilesFromText(text: string): GeneratedFile[] {
  const byPath = new Map<string, string>();
  const fence = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    const rawInfo = match[1] || "";
    const lang = rawInfo.toLowerCase();
    const code = match[2].replace(/^\r?\n/, "").replace(/\s+$/, "");
    if (!code.trim() || skippedCodeFenceLanguages.has(lang)) continue;
    // DeepSeek-style fences use the filename as the info string (```server.js).
    const langAsPath = rawInfo.includes(".") ? safeRelativeFilePath(rawInfo) : null;
    const before = text.slice(Math.max(0, match.index - 320), match.index);
    const proseHint = lastFilenameHint(before);
    const consistentHint = proseHint && fenceLangMatchesPath(lang, proseHint) ? proseHint : null;
    const inferredPath = langAsPath ?? consistentHint ?? inferFilename(lang, code);
    const path = inferredPath ? safeRelativeFilePath(inferredPath) : null;
    if (!path) continue;
    if (!isCompletePreviewHtml(path, code)) continue;
    byPath.set(path, withPreviewMarker(path, `${code}\n`));
  }

  if (byPath.size === 0) {
    const html = extractHtmlDocument(text);
    if (html) byPath.set("index.html", withPreviewMarker("index.html", `${html}\n`));
  }

  return [...byPath.entries()].map(([path, content]) => ({ path, content }));
}

function generatedRecoveryCss(): string {
  return `:root {
  color-scheme: dark;
  --bg: #090a10;
  --surface: #111520;
  --surface-2: #171c29;
  --text: #f6f7fb;
  --muted: #a9b1c3;
  --line: #2a3142;
  --accent: #8d7cff;
  --accent-2: #32d6b5;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  color: var(--text);
  background: var(--bg);
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
  line-height: 1.55;
}

a { color: inherit; }

.container, [class*="container"] {
  width: min(1120px, calc(100% - 40px));
  margin-inline: auto;
}

nav, [class*="nav"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}

section, header, footer {
  padding-block: 56px;
}

.hero, [class*="hero"] {
  min-height: 72vh;
  display: grid;
  align-items: center;
  gap: 28px;
}

h1 {
  max-width: 860px;
  margin: 0;
  font-size: clamp(44px, 8vw, 96px);
  line-height: 0.94;
  letter-spacing: 0;
}

h2 {
  margin: 0 0 12px;
  font-size: clamp(30px, 5vw, 58px);
  line-height: 1;
}

p { max-width: 720px; color: var(--muted); }

.btn, button, [class*="btn"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text);
  background: var(--surface-2);
  text-decoration: none;
}

[class*="primary"], .btn--primary {
  color: #08090f;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-color: transparent;
  font-weight: 800;
}

[class*="grid"] {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

[class*="card"], [class*="step"], [class*="panel"] {
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 16px;
}

@media (max-width: 760px) {
  nav, [class*="nav"] { align-items: flex-start; flex-direction: column; }
  section, header, footer { padding-block: 36px; }
}
`;
}

function generatedRecoveryScript(): string {
  return `window.metisPreview = true;
console.info("Metis added a placeholder script because the generated HTML referenced a missing local script.");
`;
}

function localAssetRefsFromHtml(html: string): string[] {
  const refs: string[] = [];
  const attr = /\b(?:href|src)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(html))) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith("#") || /^(?:https?:|data:|mailto:|tel:|\/\/)/i.test(raw)) continue;
    const withoutQuery = raw.split(/[?#]/)[0];
    const safe = safeRelativeFilePath(withoutQuery);
    if (safe) refs.push(safe);
  }
  return refs;
}

function inlineSingleFileAssets(files: GeneratedFile[]): { files: GeneratedFile[]; notes: string[] } {
  const notes: string[] = [];
  const byPath = new Map(files.map((file) => [safeRelativeFilePath(file.path) ?? file.path, file.content]));
  const index = files.find((file) => basename(file.path).toLowerCase() === "index.html");
  if (!index) return { files, notes };
  let html = index.content;
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["'][^>]*>/gi, (_tag, rawHref: string) => {
    const safe = safeRelativeFilePath(rawHref.split(/[?#]/)[0]);
    const css = safe ? byPath.get(safe) : undefined;
    notes.push(css ? `Inlined ${safe} for a single-file build.` : `Added fallback CSS because ${rawHref} was referenced but not generated.`);
    return `<style>\n${css ?? generatedRecoveryCss()}\n</style>`;
  });
  html = html.replace(/<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_tag, rawSrc: string) => {
    const safe = safeRelativeFilePath(rawSrc.split(/[?#]/)[0]);
    const script = safe ? byPath.get(safe) : undefined;
    notes.push(script ? `Inlined ${safe} for a single-file build.` : `Added fallback script because ${rawSrc} was referenced but not generated.`);
    return `<script>\n${script ?? generatedRecoveryScript()}\n</script>`;
  });
  return { files: [{ path: "index.html", content: withPreviewMarker("index.html", html) }], notes };
}

function prepareGeneratedFilesForPreview(files: GeneratedFile[], options: { singleFile?: boolean } = {}): { files: GeneratedFile[]; notes: string[] } {
  if (options.singleFile) return inlineSingleFileAssets(files);
  const notes: string[] = [];
  const byPath = new Map(files.map((file) => [safeRelativeFilePath(file.path) ?? file.path, file.content]));
  const next = [...files];
  // Everything any HTML file actually references.
  const referenced = new Set<string>();
  for (const file of files) {
    if (extname(file.path).toLowerCase() !== ".html") continue;
    for (const ref of localAssetRefsFromHtml(file.content)) referenced.add(ref);
  }
  for (const ref of referenced) {
    if (byPath.has(ref)) continue;
    const ext = extname(ref).toLowerCase();
    // Before fabricating a fallback, adopt a generated file with the same
    // extension that nothing references — fixes styles.css vs style.css
    // (inferred name vs the name the HTML actually links).
    const orphan = next.find(
      (file) =>
        extname(file.path).toLowerCase() === ext &&
        extname(file.path).toLowerCase() !== ".html" &&
        !referenced.has(safeRelativeFilePath(file.path) ?? file.path) &&
        (safeRelativeFilePath(file.path) ?? file.path) !== ref
    );
    if (orphan) {
      const oldPath = orphan.path;
      byPath.delete(safeRelativeFilePath(oldPath) ?? oldPath);
      orphan.path = ref;
      byPath.set(ref, orphan.content);
      notes.push(`Renamed ${oldPath} to ${ref} to match the HTML reference.`);
      continue;
    }
    if (ext === ".css") {
      next.push({ path: ref, content: generatedRecoveryCss() });
      byPath.set(ref, generatedRecoveryCss());
      notes.push(`Added fallback CSS because ${ref} was referenced but not generated.`);
    } else if ([".js", ".mjs", ".cjs"].includes(ext)) {
      next.push({ path: ref, content: generatedRecoveryScript() });
      byPath.set(ref, generatedRecoveryScript());
      notes.push(`Added fallback script because ${ref} was referenced but not generated.`);
    }
  }
  return { files: next, notes };
}

function containsGeneratedSource(text: string): boolean {
  return /```[\s\S]*```|<!doctype html|<html[\s>]|<style[\s>]|function\s+\w+\s*\(|const\s+\w+\s*=|class\s+\w+/i.test(text);
}

function fullArtifactPath(root: string, relativePath: string): string | null {
  const target = resolve(root, relativePath);
  const resolvedRoot = resolve(root);
  const prefix = resolvedRoot.endsWith("\\") || resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}\\`;
  const lowerTarget = target.toLowerCase();
  const lowerRoot = resolvedRoot.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerTarget !== lowerRoot && !lowerTarget.startsWith(lowerPrefix)) return null;
  return target;
}

async function writeTextArtifact(path: string, value: string): Promise<ProjectArtifact> {
  let removedLines = 0;
  const existed = await exists(path);
  if (existed) {
    try {
      const previous = await readFile(path, "utf8");
      removedLines = previous.length ? previous.split(/\r?\n/).length : 0;
    } catch {
      removedLines = 0;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
  const addedLines = value.length ? value.split(/\r?\n/).length : 0;
  return {
    kind: existed ? "file" : "file_create",
    label: path.split(/[\\/]/).pop() ?? path,
    path,
    bytes: Buffer.byteLength(value, "utf8"),
    addedLines,
    removedLines
  };
}

async function writeGeneratedFileSet(root: string, files: GeneratedFile[]): Promise<ProjectArtifact[]> {
  await mkdir(root, { recursive: true });
  const fileArtifacts: ProjectArtifact[] = [];
  for (const file of files) {
    const safePath = safeRelativeFilePath(file.path);
    if (!safePath) continue;
    const full = fullArtifactPath(root, safePath);
    if (!full) continue;
    fileArtifacts.push(await writeTextArtifact(full, file.content));
    await appendAudit("info", "project.write", `Wrote ${safePath}.`, { path: full });
  }
  return fileArtifacts;
}

async function verifyGeneratedProject(root: string, files: GeneratedFile[]): Promise<{
  previewUrl?: string;
  verified: boolean;
  detail: string;
  title?: string;
  statusCode?: number;
  durationMs?: number;
  consoleErrors?: string[];
  screenshotPath?: string;
  commands: AgentOperation[];
}> {
  const commands: AgentOperation[] = [];
  const jsFiles = files
    .map((file) => safeRelativeFilePath(file.path))
    .filter((path): path is string => Boolean(path))
    .filter((path) => [".cjs", ".js", ".mjs"].includes(extname(path).toLowerCase()));
  for (const file of jsFiles.slice(0, 6)) {
    commands.push(
      await runCommandOperation({
        label: `Checked ${basename(file)} syntax`,
        command: "node",
        args: ["--check", file],
        cwd: root
      })
    );
  }

  const indexFile = files
    .map((file) => safeRelativeFilePath(file.path))
    .filter((path): path is string => Boolean(path))
    .find((path) => basename(path).toLowerCase() === "index.html");
  const commandFailed = commands.some((command) => command.status !== "complete");
  if (!indexFile) {
    return {
      verified: files.length > 0 && !commandFailed,
      detail: files.length
        ? `Wrote ${files.length} file${files.length === 1 ? "" : "s"}. No index.html was found for a static preview.`
        : "No code files were found in the model output.",
      commands
    };
  }

  const previewRoot = dirname(fullArtifactPath(root, indexFile) ?? join(root, indexFile));
  const previewUrl = await ensureStaticPreview(previewRoot);
  const verificationStart = Date.now();
  const verification = await verifyPreview(previewUrl);
  const durationMs = Date.now() - verificationStart;
  return {
    previewUrl,
    verified: verification.ok && !commandFailed,
    detail: commandFailed ? `${verification.detail} One or more JavaScript syntax checks failed.` : verification.detail,
    title: verification.title,
    statusCode: verification.statusCode,
    durationMs,
    consoleErrors: verification.consoleErrors,
    screenshotPath: verification.screenshotPath,
    commands
  };
}

async function buildProjectToolResult(root: string, workspace: ProjectWorkspace | null, files: GeneratedFile[], directoryLabel: string, notes: string[] = []): Promise<ProjectToolResult> {
  const fileArtifacts = await writeGeneratedFileSet(root, files);
  const verification = await verifyGeneratedProject(root, files);
  const noteDetail = notes.length ? `${notes.join(" ")} ` : "";
  return {
    projectRoot: root,
    workspacePath: workspace?.path,
    writeMode: workspace ? "selected-project" : "app-managed",
    previewUrl: verification.previewUrl,
    verified: verification.verified,
    verificationDetail: `Wrote ${fileArtifacts.length} file${fileArtifacts.length === 1 ? "" : "s"}. ${noteDetail}${verification.detail}`,
    verificationTitle: verification.title,
    verificationStatusCode: verification.statusCode,
    verificationDurationMs: verification.durationMs,
    verificationConsoleErrors: verification.consoleErrors,
    verificationScreenshotPath: verification.screenshotPath,
    verificationCommands: verification.commands,
    artifacts: [
      { kind: "directory", label: directoryLabel, path: root },
      ...fileArtifacts,
      ...(verification.previewUrl ? [{ kind: "preview" as const, label: "Local preview", url: verification.previewUrl }] : [])
    ]
  };
}

async function createFrontendProject(prompt: string, providerResult?: ProviderInvokeResult, workspace?: ProjectWorkspace): Promise<ProjectToolResult | undefined> {
  const title = frontendTitleFromPrompt(prompt);
  const modelOutput = providerResult?.output ?? "";
  const extractedFiles = extractGeneratedFilesFromText(modelOutput);
  const prepared = prepareGeneratedFilesForPreview(extractedFiles, { singleFile: wantsSingleFileFrontend(prompt) });
  if (prepared.files.length === 0) return undefined;
  const projectRoot = workspace ? workspace.path : dataPath("generated-projects", `${Date.now()}-${slugify(title)}`);
  return buildProjectToolResult(
    projectRoot,
    workspace ?? null,
    prepared.files,
    workspace ? `Project: ${workspace.name}` : "Generated project",
    prepared.notes
  );
}

function operationsForProject(project: ProjectToolResult): AgentOperation[] {
  const operations: AgentOperation[] = [];
  let commandOperationsAdded = false;
  for (const artifact of project.artifacts) {
    if (artifact.kind === "preview" && !commandOperationsAdded) {
      operations.push(...(project.verificationCommands ?? []));
      commandOperationsAdded = true;
    }
    if (artifact.kind === "file" || artifact.kind === "file_create") {
      operations.push({
        id: randomUUID(),
        kind: artifact.kind === "file_create" ? "file_create" : "file_edit",
        label: `${artifact.kind === "file_create" ? "Created" : "Edited"} ${artifact.label}`,
        target: artifact.path,
        status: "complete",
        addedLines: artifact.addedLines ?? 0,
        removedLines: artifact.removedLines ?? 0,
        permission: "filesystem.write",
        detail: artifact.bytes ? `${Math.round(artifact.bytes / 100) / 10} KB written` : undefined
      });
      continue;
    }
    if (artifact.kind === "preview") {
      operations.push({
        id: randomUUID(),
        kind: "browser_check",
        label: "Checked local preview",
        target: artifact.url,
        url: artifact.url,
        title: project.verificationTitle,
        screenshotPath: project.verificationScreenshotPath,
        consoleErrors: project.verificationConsoleErrors,
        status: project.verified ? "complete" : "warning",
        permission: "network.web",
        durationMs: project.verificationDurationMs,
        detail: project.verificationDetail
      });
      continue;
    }
    operations.push({
      id: randomUUID(),
      kind: "directory_create",
      label: artifact.label,
      target: artifact.path,
      status: "complete",
      permission: "filesystem.write"
    });
  }
  if (!commandOperationsAdded) operations.push(...(project.verificationCommands ?? []));
  return operations;
}

type SessionStreamController = {
  emit: (event: SessionStreamEvent) => void;
};

function timelineText(content: string): SessionTimelineEvent {
  return { id: randomUUID(), kind: "text", content };
}

function emitStream(stream: SessionStreamController | undefined, event: SessionStreamEvent): void {
  stream?.emit(event);
}

function emitTimeline(stream: SessionStreamController | undefined, event: SessionTimelineEvent): void {
  emitStream(stream, { kind: "timeline", event });
}

function buildRunTimelineForBuild(input: {
  stages: OrchestrationStage[];
  projectResult?: ProjectToolResult;
  operations?: AgentOperation[];
  fileCount: number;
  targetName?: string;
}): SessionTimelineEvent[] {
  const events: SessionTimelineEvent[] = [
    {
      id: randomUUID(),
      kind: "text",
      content: "I’ll run this through the build pipeline and turn the model output into real project files."
    },
    { id: randomUUID(), kind: "route" }
  ];

  const plan = input.stages.find((stage) => stage.id === "plan");
  const frontend = input.stages.find((stage) => stage.id === "frontend");
  const functional = input.stages.find((stage) => stage.id === "functional");
  if (plan) events.push({ id: randomUUID(), kind: "stage", stageId: plan.id });
  if (frontend) {
    events.push({
      id: randomUUID(),
      kind: "text",
      content: "Now I’m handing the plan to the front-end route."
    });
    events.push({ id: randomUUID(), kind: "stage", stageId: frontend.id });
  }
  if (functional) {
    events.push({
      id: randomUUID(),
      kind: "text",
      content: "Now I’m checking whether the generated front end needs functionality or support files."
    });
    events.push({ id: randomUUID(), kind: "stage", stageId: functional.id });
  }

  const operations = input.operations ?? [];
  const fileOperationIds = operations
    .filter((operation) => operation.kind === "file_create" || operation.kind === "file_edit" || operation.kind === "directory_create")
    .map((operation) => operation.id);
  const checkOperationIds = operations
    .filter((operation) => operation.kind === "command" || operation.kind === "browser_check")
    .map((operation) => operation.id);

  if (fileOperationIds.length > 0) {
    events.push({
      id: randomUUID(),
      kind: "text",
      content: `I’ve got the generated files. Writing them into ${input.targetName ?? "the selected workspace"} now.`
    });
    events.push({
      id: randomUUID(),
      kind: "operations",
      title: "File writes",
      detail: `${input.fileCount} file${input.fileCount === 1 ? "" : "s"} written`,
      operationIds: fileOperationIds
    });
  }
  if (checkOperationIds.length > 0) {
    events.push({
      id: randomUUID(),
      kind: "text",
      content: "Now I’m checking syntax and loading the preview."
    });
    events.push({
      id: randomUUID(),
      kind: "operations",
      title: "Verification",
      detail: input.projectResult?.verificationDetail,
      operationIds: checkOperationIds
    });
  }
  events.push({
    id: randomUUID(),
    kind: "text",
    content: input.projectResult?.verified
      ? `Done - the project files are written and the preview verified at ${input.projectResult.previewUrl ?? input.projectResult.projectRoot}.`
      : input.projectResult
        ? `The files are written, but the preview still needs attention: ${input.projectResult.verificationDetail ?? "no preview verification was available."}`
        : "I could not find a complete writable file in the model output, so I did not write anything to the project folder."
  });
  return events;
}

async function runCommandOperation(input: { label: string; command: string; args: string[]; cwd: string }): Promise<AgentOperation> {
  const started = Date.now();
  const commandLine = [input.command, ...input.args.map(formatCommandArg)].join(" ");
  try {
    const { stdout, stderr } = await execFileAsync(input.command, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 1024 * 1024
    });
    return {
      id: randomUUID(),
      kind: "command",
      label: input.label,
      target: input.cwd,
      status: "complete",
      command: commandLine,
      cwd: input.cwd,
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: trimCommandOutput(stdout),
      stderr: trimCommandOutput(stderr),
      permission: "process.spawn",
      detail: "Command completed successfully."
    };
  } catch (error) {
    const execError = error as Error & { code?: string | number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      id: randomUUID(),
      kind: "command",
      label: input.label,
      target: input.cwd,
      status: "error",
      command: commandLine,
      cwd: input.cwd,
      exitCode: typeof execError.code === "number" ? execError.code : undefined,
      durationMs: Date.now() - started,
      stdout: trimCommandOutput(execError.stdout),
      stderr: trimCommandOutput(execError.stderr ?? execError.message),
      permission: "process.spawn",
      detail: "Command failed."
    };
  }
}

async function maybeRunRequestedProjectCommand(
  prompt: string,
  workspace: ProjectWorkspace | null,
  mode: PermissionMode,
  stream?: SessionStreamController
): Promise<AgentOperation[]> {
  const request = projectCommandRequest(prompt);
  if (!request) return [];
  if (!workspace) {
    return [
      {
        id: randomUUID(),
        kind: "command",
        label: `Skipped ${request.label.toLowerCase()}`,
        status: "warning",
        permission: "process.spawn",
        detail: "Choose a project folder before Metis can run project commands."
      }
    ];
  }
  if (mode === "plan") {
    return [
      {
        id: randomUUID(),
        kind: "command",
        label: `Skipped ${request.label.toLowerCase()}`,
        target: workspace.path,
        status: "warning",
        cwd: workspace.path,
        permission: "process.spawn",
        detail: "Plan mode — nothing was run."
      }
    ];
  }
  // Command execution gates on process.spawn: ask + edits always prompt, auto
  // prompts only when there's no existing grant, bypass never prompts
  // (docs/FABLE_PLANS.md section 24).
  const gate = await gatePermission({
    stream,
    mode,
    scope: "process.spawn",
    target: workspace.path,
    projectPath: workspace.path,
    detail: `Run "${request.label.toLowerCase()}" in ${workspace.name}?`
  });
  if (!gate.proceed) {
    emitTimeline(stream, timelineText(`Permission denied — skipped ${request.label.toLowerCase()}.`));
    return [
      {
        id: randomUUID(),
        kind: "command",
        label: `Denied ${request.label.toLowerCase()}`,
        target: workspace.path,
        status: "warning",
        cwd: workspace.path,
        permission: "process.spawn",
        detail: "Permission was denied, so this command did not run."
      }
    ];
  }
  const packagePath = join(workspace.path, "package.json");
  if (!(await exists(packagePath))) {
    return [
      {
        id: randomUUID(),
        kind: "command",
        label: `Skipped ${request.label.toLowerCase()}`,
        target: workspace.path,
        status: "warning",
        cwd: workspace.path,
        permission: "process.spawn",
        detail: "No package.json was found in the selected project folder."
      }
    ];
  }
  return [
    await runCommandOperation({
      label: request.label,
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", request.script, "--if-present"],
      cwd: workspace.path
    })
  ];
}

function projectCommandRequest(prompt: string): { label: string; script: "test" | "build" | "lint" } | null {
  if (/\b(run|execute|check|verify)\b[\s\S]{0,40}\b(test|tests|testing)\b|\b(test|tests)\b[\s\S]{0,24}\b(project|repo|suite)\b/i.test(prompt)) {
    return { label: "Ran project tests", script: "test" };
  }
  if (/\b(run|execute|check|verify)\b[\s\S]{0,40}\b(build|compile)\b|\bbuild\b[\s\S]{0,24}\b(project|repo|app)\b/i.test(prompt)) {
    return { label: "Ran project build", script: "build" };
  }
  if (/\b(run|execute|check|verify)\b[\s\S]{0,40}\b(lint|eslint)\b|\blint\b[\s\S]{0,24}\b(project|repo|code)\b/i.test(prompt)) {
    return { label: "Ran project lint", script: "lint" };
  }
  return null;
}

function formatCommandArg(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function trimCommandOutput(value: string | Buffer | undefined): string | undefined {
  if (!value) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.length > 4000 ? `${text.slice(0, 4000)}\n... output truncated ...` : text;
}

async function ensureStaticPreview(root: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const existing = projectPreviewServers.get(resolvedRoot);
  if (existing) return existing.url;

  const server = createServer((request, response) => {
    void serveStaticFile(resolvedRoot, request.url ?? "/", response);
  });
  const url = await new Promise<string>((resolveUrl, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolveUrl(`http://127.0.0.1:${address.port}/`);
    });
  });
  projectPreviewServers.set(resolvedRoot, { server, url });
  return url;
}

async function serveStaticFile(root: string, rawUrl: string, response: ServerResponse): Promise<void> {
  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    const pathname = decodeURIComponent(parsed.pathname === "/" ? "/index.html" : parsed.pathname);
    const target = resolve(root, `.${pathname}`);
    if (!target.toLowerCase().startsWith(root.toLowerCase())) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    const data = await readFile(target);
    response.writeHead(200, { "content-type": mimeTypeFor(target) });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function mimeTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function verifyPreview(url: string): Promise<PreviewVerificationResult> {
  try {
    const response = await fetch(url);
    const text = await response.text();
    const htmlTitle = /<title>(.*?)<\/title>/i.exec(text)?.[1]?.trim();
    const browserEvidence: BrowserPreviewEvidence = await verifyPreviewInBrowser(url).catch((error: unknown) => ({
      consoleErrors: [`Browser verification failed: ${error instanceof Error ? error.message : String(error)}`]
    }));
    const title = browserEvidence.title ?? htmlTitle;
    const consoleErrors = browserEvidence.consoleErrors ?? [];
    const markerReady = text.includes('data-metis-preview="ready"') || text.includes("metisPreview") || Boolean(browserEvidence.markerReady);

    if (!response.ok) {
      return {
        ok: false,
        detail: `Preview returned HTTP ${response.status}.`,
        title,
        statusCode: response.status,
        consoleErrors,
        screenshotPath: browserEvidence.screenshotPath
      };
    }
    if (!markerReady) {
      return {
        ok: false,
        detail: "Preview responded, but the Metis readiness marker was missing.",
        title,
        statusCode: response.status,
        consoleErrors,
        screenshotPath: browserEvidence.screenshotPath
      };
    }
    if (consoleErrors.length > 0) {
      return {
        ok: false,
        detail: `Preview loaded, but ${consoleErrors.length} console error${consoleErrors.length === 1 ? "" : "s"} were captured.`,
        title,
        statusCode: response.status,
        consoleErrors,
        screenshotPath: browserEvidence.screenshotPath
      };
    }
    return {
      ok: true,
      detail: "Preview responded, rendered in a hidden browser, and the Metis readiness marker is present.",
      title,
      statusCode: response.status,
      consoleErrors,
      screenshotPath: browserEvidence.screenshotPath
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyPreviewInBrowser(url: string): Promise<BrowserPreviewEvidence> {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const consoleErrors: string[] = [];
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 2) return;
    consoleErrors.push(`${message}${sourceId ? ` (${sourceId}:${line})` : ""}`);
  });

  try {
    await withTimeout(window.loadURL(url), 8_000, "Timed out loading local preview.");
    const markerReady = await withTimeout(
      window.webContents.executeJavaScript(
        "Boolean(document.querySelector('[data-metis-preview=\"ready\"]') || window.metisPreview || document.documentElement.innerHTML.includes('metisPreview'))",
        true
      ),
      3_000,
      "Timed out checking readiness marker."
    );
    const image = await window.webContents.capturePage();
    const screenshotPath = dataPath("preview-screenshots", `${Date.now()}-${randomUUID()}.png`);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, image.toPNG());
    return {
      title: window.webContents.getTitle(),
      markerReady: Boolean(markerReady),
      consoleErrors: consoleErrors.slice(0, 12),
      screenshotPath
    };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildAssistantText(input: SessionRunInput, _decision: RouteDecision, _pipelineName: string, providerResult?: ProviderInvokeResult, projectResult?: ProjectToolResult): string {
  const output = providerResult?.source !== "placeholder" ? providerResult?.output.trim() : "";
  if (projectResult && output && containsGeneratedSource(output)) {
    const fileCount = projectResult.artifacts.filter((artifact) => artifact.kind === "file" || artifact.kind === "file_create").length;
    const preview = projectResult.previewUrl ? ` Preview is running at ${projectResult.previewUrl}.` : "";
    return `Done. I extracted the model output into ${fileCount} file${fileCount === 1 ? "" : "s"} at ${projectResult.projectRoot}.${preview}`;
  }
  if (output) return output;
  if (projectResult?.previewUrl) return "Done. The generated project is attached below with the local preview and verification result.";
  if (input.rawPromptStorage === "hash-only") return "The route completed without storing the raw prompt, but no live model answer was returned.";
  return "The route completed, but no live model answer was returned.";
}

async function readSessionRuns(): Promise<SessionRun[]> {
  return readStoreValue<SessionRun[]>("sessionRuns", []);
}

async function writeSessionRuns(runs: SessionRun[]): Promise<void> {
  await writeStoreValue("sessionRuns", runs.slice(0, 100));
}

async function writeSessionRun(run: SessionRun): Promise<void> {
  const current = await readSessionRuns();
  await writeSessionRuns([run, ...current]);
}

async function readConversations(): Promise<ConversationRecord[]> {
  return readStoreValue<ConversationRecord[]>("conversations", []);
}

async function writeConversations(conversations: ConversationRecord[]): Promise<void> {
  await writeStoreValue("conversations", conversations.slice(0, 200));
}

function conversationTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim();
  return cleaned.split(" ").slice(0, 7).join(" ") || "New session";
}

async function createConversation(projectPath?: string, firstPrompt?: string): Promise<ConversationRecord> {
  const now = new Date().toISOString();
  const conversation: ConversationRecord = {
    id: randomUUID(),
    projectPath,
    title: firstPrompt ? conversationTitle(firstPrompt) : "New session",
    createdAt: now,
    updatedAt: now,
    turns: []
  };
  const current = await readConversations();
  await writeConversations([conversation, ...current]);
  return conversation;
}

async function deleteConversation(id: string): Promise<ConversationRecord[]> {
  const current = await readConversations();
  const conversation = current.find((item) => item.id === id);
  const next = current.filter((item) => item.id !== id);
  await writeConversations(next);

  const deletedRunIds = new Set(conversation?.turns.map((turn) => turn.runId).filter(Boolean) ?? []);
  const runs = await readSessionRuns();
  await writeSessionRuns(runs.filter((run) => run.conversationId !== id && !deletedRunIds.has(run.id)));

  if (conversation) {
    await appendAudit("info", "conversation.delete", `Deleted conversation ${conversation.title}.`, {
      id,
      projectPath: conversation.projectPath
    });
  }
  return next;
}

async function renameConversation(id: string, title: string): Promise<ConversationRecord[]> {
  const trimmed = title.trim();
  const current = await readConversations();
  const conversation = current.find((item) => item.id === id);
  if (!conversation || !trimmed) return current;

  const next = current.map((item) => (item.id === id ? { ...item, title: trimmed, titleManual: true } : item));
  await writeConversations(next);
  await appendAudit("info", "conversation.rename", `Renamed conversation to "${trimmed}".`, { id });
  return next;
}

async function archiveConversation(id: string, archived: boolean): Promise<ConversationRecord[]> {
  const current = await readConversations();
  const conversation = current.find((item) => item.id === id);
  if (!conversation) return current;

  const next = current.map((item) => (item.id === id ? { ...item, archived } : item));
  await writeConversations(next);
  await appendAudit("info", "conversation.archive", `${archived ? "Archived" : "Unarchived"} conversation ${conversation.title}.`, {
    id,
    archived
  });
  return next;
}

function conversationToMarkdown(record: ConversationRecord): string {
  const lines: string[] = [];
  lines.push(`# ${record.title || "Untitled conversation"}`);
  lines.push("");
  const meta = [`Created ${record.createdAt}`, `Updated ${record.updatedAt}`];
  if (record.projectPath) meta.push(`Project: ${record.projectPath}`);
  lines.push(`_${meta.join(" · ")}_`);
  lines.push("");
  for (const turn of record.turns) {
    lines.push(turn.role === "user" ? "## You" : "## Metis");
    lines.push(`_${turn.createdAt}_`);
    lines.push("");
    lines.push((turn.content ?? "").trim() || "_(empty)_");
    if (turn.run) {
      const runMeta: string[] = [];
      if (turn.run.pipelineName) runMeta.push(`pipeline: ${turn.run.pipelineName}`);
      if (turn.run.routeLabel) runMeta.push(`route: ${turn.run.routeLabel}`);
      if (runMeta.length > 0) {
        lines.push("");
        lines.push(`> ${runMeta.join(" · ")}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function exportConversationsMarkdown(conversationId?: string): Promise<ConversationExportResult> {
  try {
    const conversations = await readConversations();
    let markdown: string;
    let defaultName: string;
    let auditSummary: string;

    if (conversationId) {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (!conversation) return { ok: false, error: "That conversation no longer exists." };
      markdown = conversationToMarkdown(conversation);
      defaultName = `${slugify(conversation.title || "conversation")}.md`;
      auditSummary = `Exported conversation "${conversation.title}" to Markdown.`;
    } else {
      if (conversations.length === 0) return { ok: false, error: "There are no conversations to export." };
      markdown = conversations.map((conversation) => conversationToMarkdown(conversation)).join("\n---\n\n");
      defaultName = "metis-conversations.md";
      auditSummary = `Exported ${conversations.length} conversation${conversations.length === 1 ? "" : "s"} to Markdown.`;
    }

    const result = await dialog.showSaveDialog({
      title: "Export conversation as Markdown",
      defaultPath: defaultName,
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "All Files", extensions: ["*"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

    await mkdir(dirname(result.filePath), { recursive: true });
    await writeFile(result.filePath, markdown, "utf8");
    await appendAudit("info", "conversation.export", auditSummary, { conversationId, path: result.filePath });

    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function conversationProjectMatches(conversation: ConversationRecord, projectPath?: string): boolean {
  if (!projectPath) return !conversation.projectPath;
  return Boolean(conversation.projectPath) && sameResolvedPath(conversation.projectPath ?? "", projectPath);
}

async function deleteProjectConversations(projectPath?: string): Promise<ConversationRecord[]> {
  const current = await readConversations();
  const deleted = current.filter((conversation) => conversationProjectMatches(conversation, projectPath));
  const next = current.filter((conversation) => !conversationProjectMatches(conversation, projectPath));
  await writeConversations(next);

  const deletedConversationIds = new Set(deleted.map((conversation) => conversation.id));
  const deletedRunIds = new Set(deleted.flatMap((conversation) => conversation.turns.map((turn) => turn.runId).filter(Boolean)));
  const runs = await readSessionRuns();
  await writeSessionRuns(
    runs.filter((run) => {
      const sameProject = projectPath
        ? Boolean(run.projectPath) && sameResolvedPath(run.projectPath ?? "", projectPath)
        : !run.projectPath;
      return !sameProject && !deletedConversationIds.has(run.conversationId ?? "") && !deletedRunIds.has(run.id);
    })
  );

  if (deleted.length > 0) {
    await appendAudit("info", "project.conversations.delete", `Deleted ${deleted.length} conversation${deleted.length === 1 ? "" : "s"} for a project.`, {
      projectPath,
      count: deleted.length
    });
  }
  return next;
}

async function appendRunToConversation(run: SessionRun, prompt: string): Promise<string> {
  const current = await readConversations();
  let conversation = run.conversationId ? current.find((item) => item.id === run.conversationId) : undefined;
  if (!conversation) {
    conversation = {
      id: run.conversationId ?? randomUUID(),
      projectPath: run.projectPath,
      title: conversationTitle(prompt),
      createdAt: run.createdAt,
      updatedAt: run.completedAt,
      turns: []
    };
  }

  const userTurn: ConversationTurnRecord = {
    id: randomUUID(),
    role: "user",
    createdAt: run.createdAt,
    content: prompt,
    runId: run.id
  };
  const assistantTurn: ConversationTurnRecord = {
    id: randomUUID(),
    role: "assistant",
    createdAt: run.completedAt,
    content: run.assistantText,
    runId: run.id,
    run
  };
  const nextConversation: ConversationRecord = {
    ...conversation,
    projectPath: run.projectPath ?? conversation.projectPath,
    updatedAt: run.completedAt,
    turns: [...conversation.turns, userTurn, assistantTurn]
  };
  await writeConversations([nextConversation, ...current.filter((item) => item.id !== nextConversation.id)]);
  return nextConversation.id;
}

/** A prompt too short/thin to summarise meaningfully ("hi", "test", "yo") —
 *  auto-titling would just reproduce the existing first-prompt-slice title,
 *  so skip calling the model and leave the placeholder title in place. */
function isTrivialTitlePrompt(prompt: string): boolean {
  const words = prompt.split(/\s+/).filter(Boolean);
  return words.length <= 2 && prompt.length <= 12;
}

/** Marks a conversation as "auto-title attempted" without changing its title
 *  — used for the trivial-prompt skip so we never re-attempt on later turns. */
async function markAutoTitleAttempted(conversationId: string): Promise<void> {
  const current = await readConversations();
  const next = current.map((item) => (item.id === conversationId ? { ...item, autoTitleAttempted: true } : item));
  await writeConversations(next);
}

/** Normalises a raw local-model title reply into a clean, short, Title-Case-ish
 *  string: first line only, quotes/trailing punctuation stripped, capped at 6
 *  words. Returns null for anything that doesn't look like a real title (empty,
 *  too long/rambling, or unparseable), so the caller can fall back safely. */
function cleanGeneratedTitle(raw: string): string | null {
  let text = stripThinkBlocks(raw).split("\n")[0] ?? "";
  text = text.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  text = text.replace(/[.!?;:,]+$/g, "").trim();
  text = text.replace(/\s+/g, " ");
  if (!text || text.length > 80) return null;
  const words = text.split(" ").filter(Boolean).slice(0, 6);
  if (words.length === 0) return null;
  const titled = words.map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
  return titled.length >= 2 ? titled : null;
}

/** Calls the local Ollama model (localStageRef — always free/local, never a
 *  paid cloud call) with a tight titling prompt built from the first exchange.
 *  Fails soft: any provider error, placeholder result, or unparseable reply
 *  returns null so the caller falls back to the first-prompt-slice title. */
async function generateLocalTitle(prompt: string, assistantText: string): Promise<string | null> {
  try {
    const ref = localStageRef();
    const titlePrompt = `Summarise this conversation as a short title of at most 6 words, no quotes, no punctuation at the end. Reply with only the title.

User: ${prompt.slice(0, 800)}
Assistant: ${assistantText.slice(0, 800)}`;
    const result = await invokeProvider({ provider: ref.provider, model: ref.model, prompt: titlePrompt });
    if (result.source === "placeholder" || !result.output.trim()) return null;
    return cleanGeneratedTitle(result.output);
  } catch {
    return null;
  }
}

/** Owner's principle: new conversations start with a throwaway first-prompt-
 *  slice title ("New session" / conversationTitle(prompt)); this replaces it
 *  ONCE with a real local-model-generated title after the first exchange
 *  completes, so the sidebar reads like a real conversation list instead of
 *  raw prompt fragments. Called fire-and-forget from runSession — never
 *  awaited on the run's return path, and every failure mode (missing
 *  conversation, manual rename, already-attempted, model unavailable, junk
 *  reply) degrades to "do nothing" or "keep the existing placeholder title",
 *  never to a thrown error. */
async function maybeAutoTitleConversation(conversationId: string, firstPrompt: string, assistantText: string): Promise<void> {
  try {
    const current = await readConversations();
    const conversation = current.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (conversation.titleManual || conversation.autoTitleAttempted) return;
    // Only the conversation's first exchange (one user turn + one assistant
    // turn) should ever trigger auto-titling.
    if (conversation.turns.length !== 2) return;

    const trimmedPrompt = firstPrompt.trim();
    if (isTrivialTitlePrompt(trimmedPrompt)) {
      await markAutoTitleAttempted(conversationId);
      return;
    }

    const generated = await generateLocalTitle(trimmedPrompt, assistantText);
    const finalTitle = generated ?? conversationTitle(trimmedPrompt);

    // Re-read right before writing so a concurrent rename or new turn (the
    // background model call can take a few seconds) never gets clobbered.
    const latest = await readConversations();
    const latestConversation = latest.find((item) => item.id === conversationId);
    if (!latestConversation || latestConversation.titleManual || latestConversation.autoTitleAttempted) return;
    const next = latest.map((item) => (item.id === conversationId ? { ...item, title: finalTitle, autoTitleAttempted: true } : item));
    await writeConversations(next);
  } catch {
    // Titling must never surface as a run failure — swallow everything.
  }
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

const CONVERSATION_CONTEXT_TURN_CHAR_CAP = 400;
const CONVERSATION_CONTEXT_TOTAL_CHAR_CAP = 3000;

/** Owner's principle: the pipeline must carry conversation context into every
 *  model call, not just the raw current prompt — otherwise each turn is a
 *  fresh one-shot with no memory of what was just discussed. Loads the last
 *  `maxTurns` turns of the given conversation, formats them "User: ..." /
 *  "Metis: ...", trims each turn to ~400 chars, and caps the whole block at
 *  ~3000 chars (dropping oldest turns first) so it stays small enough to
 *  coexist with the file dump / METIS.md block in a single stage prompt.
 *  Returns null when there's no conversation id or no turns yet. */
async function recentConversationContext(conversationId?: string, maxTurns = 6): Promise<string | null> {
  if (!conversationId) return null;
  const conversations = await readConversations();
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation || conversation.turns.length === 0) return null;

  const recentTurns = conversation.turns.slice(-maxTurns);
  const lines = recentTurns.map((turn) => {
    const speaker = turn.role === "user" ? "User" : "Metis";
    const content = turn.content.length > CONVERSATION_CONTEXT_TURN_CHAR_CAP ? `${turn.content.slice(0, CONVERSATION_CONTEXT_TURN_CHAR_CAP)}...` : turn.content;
    return `${speaker}: ${content}`;
  });

  // Total cap: drop oldest lines first if still too big.
  let block = lines.join("\n");
  while (block.length > CONVERSATION_CONTEXT_TOTAL_CHAR_CAP && lines.length > 1) {
    lines.shift();
    block = lines.join("\n");
  }
  if (block.length > CONVERSATION_CONTEXT_TOTAL_CHAR_CAP) block = block.slice(0, CONVERSATION_CONTEXT_TOTAL_CHAR_CAP);
  return block || null;
}

type StageModelRef = { provider: ProviderKey; model: string };
// `gatewayPreference` (docs/FABLE_PLANS.md section 25) is the ordered route
// preference for this stage's PRIMARY model only (a graph node's "Gateway" +
// "Gateway fallbacks" controls — formerly a single "Access via" pin):
// [gateway, ...gatewayFallbacks]. callStageWithFallback/expandChainByRoutes
// apply it exclusively to chain[0], trying each listed route in order
// (skipping unconfigured ones) before falling through to the model's
// remaining access routes by the usual healthy-first ordering.
// `templateRole` (section 25) decouples the STAGE PROMPT TEMPLATE from the
// stage id: default stages use their own id as the role, but graph-driven
// stages keep the graph node's real id (for audit/result tracking) and pick
// their prompt template by POSITION instead — first stage plans, second
// builds the front end, the rest are functional/support passes.
type StageConfig = { id: string; label: string; chain: StageModelRef[]; gatewayPreference?: ProviderKey[]; templateRole: "plan" | "frontend" | "functional" };

function localStageRef(): StageModelRef {
  return { provider: "ollama", model: providerInfo.ollama.defaultModel ?? "qwen3:8b" };
}

function stageModelLabel(ref: StageModelRef): string {
  return `${providerInfo[ref.provider].label} (${ref.model})`;
}

function wantsSingleFileFrontend(prompt: string): boolean {
  return (
    /\b(single[- ]?file|one file|index\.html only|complete index\.html only|single html|single-page html)\b/i.test(prompt) &&
    /\b(html|front\s?end|frontend|landing page|website|web ?page|ui|site)\b/i.test(prompt)
  );
}

// Known display names from the composer picker -> real API/tag ids. Custom
// models the user adds may already be raw ids, so unknown names pass through
// a light heuristic instead of failing.
const MODEL_DISPLAY_IDS: Partial<Record<ProviderKey, Record<string, string>>> = {
  anthropic: {
    "opus 4.8": "claude-opus-4-8",
    "sonnet 5": "claude-sonnet-5",
    "fable 5": "claude-fable-5",
    "haiku 4.5": "claude-haiku-4-5-20251001"
  },
  openai: {
    "gpt-5.1": "gpt-5.1",
    "gpt-5 mini": "gpt-5-mini"
  },
  gemini: {
    "2.5 pro": "gemini-2.5-pro",
    "2.5 flash": "gemini-2.5-flash"
  },
  deepseek: {
    v3: "deepseek-chat",
    r1: "deepseek-reasoner"
  },
  openrouter: {
    "grok 4": "x-ai/grok-4"
  },
  nvidia: {
    "deepseek v3.1 (nvidia)": "deepseek-ai/deepseek-v3.1"
  },
  groq: {
    "llama 3.3 70b": "llama-3.3-70b-versatile"
  },
  ollama: {
    "qwen2.5 72b": "qwen2.5:72b",
    "qwen3 4b": "qwen3:4b",
    "glm-4.6": "glm4"
  }
};

function resolveOverrideModel(override: SessionModelOverride): string {
  const raw = override.model.trim();
  const mapped = MODEL_DISPLAY_IDS[override.provider]?.[raw.toLowerCase()];
  if (mapped) return mapped;
  // Already looks like a real id (ollama tag, dotted/dashed API id, or org/model path).
  if (/[:/]/.test(raw) || (/^[a-z0-9][a-z0-9.-]*$/.test(raw) && raw.includes("-"))) return raw;
  // Ollama display names follow "family size" ("Qwen3 8B") and their real tags
  // follow "family:size" ("qwen3:8b"). The old slug fallback turned these into
  // "qwen3-8b" (dash), which Ollama 404s on - the bug Lachy hit when the picker
  // said Installed but the pinned run failed. Generalize instead of extending
  // the hand-kept MODEL_DISPLAY_IDS map one model at a time.
  if (override.provider === "ollama") {
    const familySize = raw.toLowerCase().match(/^([a-z0-9.-]+)\s+(\d+(?:\.\d+)?b)$/i);
    if (familySize) return `${familySize[1]}:${familySize[2]}`;
  }
  // Best-effort slug for hand-typed names like "GPT 5.6" -> "gpt-5.6".
  return raw.toLowerCase().replace(/\s+/g, "-");
}

function overrideStageRef(override: SessionModelOverride): StageModelRef {
  return { provider: override.provider, model: resolveOverrideModel(override) };
}

function overrideDisplayLabel(override: SessionModelOverride): string {
  const model = override.model;
  const raw = override.label ?? `${providerInfo[override.provider].label} ${model}`;
  // Labels are built as "<brand> <model>" — either the renderer's own
  // "<brand> <model>" override.label (e.g. "Qwen" + "Qwen3 8B"), or the
  // providerInfo fallback above. When the model name already starts with
  // that brand, or the brand's first word ("Qwen3 8B" already starts with
  // "Qwen"), prefixing it again just doubles it ("Qwen Qwen3 8B") — collapse
  // to the bare model name. Otherwise keep the concat as-is.
  const modelLower = model.toLowerCase();
  const rawLower = raw.toLowerCase();
  if (rawLower.endsWith(modelLower) && rawLower.length > modelLower.length) {
    const brand = raw.slice(0, raw.length - model.length).trim();
    const brandFirstWord = brand.split(/\s+/)[0] ?? "";
    const brandLower = brand.toLowerCase();
    if (brand && (modelLower.startsWith(brandLower) || (brandFirstWord && modelLower.startsWith(brandFirstWord.toLowerCase())))) {
      return model;
    }
  }
  return raw;
}

// Default agentic build pipeline. The model per stage will later come from the
// orchestration graph; each chain ends in the local model so the flow always runs.
// A user-pinned model goes first in every chain, with the defaults as fallbacks.
function defaultAgenticStages(prompt = "", override?: SessionModelOverride): StageConfig[] {
  const claude: StageModelRef = { provider: "anthropic", model: providerInfo.anthropic.defaultModel ?? "claude-sonnet-4-6" };
  const gemini: StageModelRef = { provider: "gemini", model: providerInfo.gemini.defaultModel ?? "gemini-2.5-pro" };
  const deepseek: StageModelRef = { provider: "deepseek", model: "deepseek-chat" };
  const stages: StageConfig[] = [
    { id: "plan", label: "Plan", chain: [gemini, claude, localStageRef()], templateRole: "plan" },
    { id: "frontend", label: "Front end", chain: [claude, deepseek, localStageRef()], templateRole: "frontend" },
    { id: "functional", label: "Make functional", chain: [deepseek, claude, localStageRef()], templateRole: "functional" }
  ];
  const scoped = wantsSingleFileFrontend(prompt) ? stages.filter((stage) => stage.id !== "functional") : stages;
  if (!override) return scoped;
  const pinned = overrideStageRef(override);
  return scoped.map((stage) => ({
    ...stage,
    chain: [pinned, ...stage.chain.filter((ref) => ref.provider !== pinned.provider || ref.model !== pinned.model)]
  }));
}

function isKnownProvider(provider: string): provider is ProviderKey {
  return Object.prototype.hasOwnProperty.call(providerInfo, provider);
}

/** Normalizes a graph node's raw model text the same way the composer pin's
 *  override goes through resolveOverrideModel — the renderer sends display
 *  names ("Sonnet 5") for library picks and raw ids for hand-typed/custom
 *  models, so both paths need the same MODEL_DISPLAY_IDS lookup + heuristic
 *  fallback (docs/FABLE_PLANS.md section 25). */
function resolveGraphStageModel(provider: ProviderKey, rawModel: string): string {
  return resolveOverrideModel({ provider, model: rawModel });
}

/** Builds a StageConfig[] from the graph pipeline projected by the renderer
 *  (docs/FABLE_PLANS.md section 25) — turns the user's orchestration graph
 *  into the same shape defaultAgenticStages produces, so the rest of
 *  runOrchestratedStages (prompt templates, critic loop, streaming) doesn't
 *  need to know the difference. Invalid/unknown providers or empty models are
 *  dropped silently (fail-soft); stage prompt template is chosen by POSITION
 *  (first = plan, second = frontend, rest = functional), not by node id/label,
 *  since graph node ids are arbitrary. Every chain still ends in the local
 *  model so the run always completes even if every configured route fails. */
function graphAgenticStages(config: GraphPipelineConfig, prompt: string, override?: SessionModelOverride): StageConfig[] | null {
  const usable = config.stages.filter((stage) => isKnownProvider(stage.provider) && stage.model.trim().length > 0);
  if (usable.length < 2) return null;

  const singleFile = wantsSingleFileFrontend(prompt);
  const templateRoleFor = (index: number): StageConfig["templateRole"] => (index === 0 ? "plan" : index === 1 ? "frontend" : "functional");

  const stages: StageConfig[] = usable.map((stage, index) => {
    const primary: StageModelRef = { provider: stage.provider, model: resolveGraphStageModel(stage.provider, stage.model) };
    const fallbackRefs: StageModelRef[] = stage.fallback
      .filter((ref) => isKnownProvider(ref.provider) && ref.model.trim().length > 0)
      .map((ref) => ({ provider: ref.provider, model: resolveGraphStageModel(ref.provider, ref.model) }));
    // Gateway + gateway fallbacks (docs/FABLE_PLANS.md section 25): the
    // renderer sends `gateway`/`gatewayFallbacks` for graphs authored with the
    // new NodeInspector controls; older persisted graphs (or older renderer
    // builds) may only send the single `accessVia` pin, which becomes the
    // sole entry of the preference list.
    const gateway = stage.gateway && isKnownProvider(stage.gateway) ? stage.gateway : stage.accessVia && isKnownProvider(stage.accessVia) ? stage.accessVia : undefined;
    const gatewayFallbacks = (stage.gatewayFallbacks ?? []).filter((provider): provider is ProviderKey => isKnownProvider(provider));
    const gatewayPreference = gateway ? [gateway, ...gatewayFallbacks.filter((provider) => provider !== gateway)] : gatewayFallbacks.length > 0 ? gatewayFallbacks : undefined;
    return {
      id: stage.id,
      label: stage.label || `Stage ${index + 1}`,
      chain: [primary, ...fallbackRefs, localStageRef()],
      gatewayPreference,
      templateRole: templateRoleFor(index)
    };
  });

  // Single-file frontend requests still collapse to just plan+frontend, same
  // as the default pipeline — drop anything past the second stage.
  const scoped = singleFile ? stages.slice(0, 2) : stages;
  if (!override) return scoped;
  const pinned = overrideStageRef(override);
  return scoped.map((stage) => ({
    ...stage,
    chain: [pinned, ...stage.chain.filter((ref) => ref.provider !== pinned.provider || ref.model !== pinned.model)]
  }));
}

/** Resolves the stage list for a build run (docs/FABLE_PLANS.md section 25):
 *  prefers the user's orchestration graph (projected by the renderer into the
 *  "graphPipeline" store key) when it has at least two usable stages, else
 *  falls back to the hardcoded defaultAgenticStages. The model override
 *  (composer pin) applies identically either way — it still prepends every
 *  chain, outranking both the graph and the defaults. */
async function resolveAgenticStages(prompt: string, override?: SessionModelOverride): Promise<{ stages: StageConfig[]; source: "graph" | "default" }> {
  const graphConfig = await readStoreValue<GraphPipelineConfig | null>("graphPipeline", null);
  if (graphConfig && Array.isArray(graphConfig.stages)) {
    const graphStages = graphAgenticStages(graphConfig, prompt, override);
    if (graphStages && graphStages.length >= 2) return { stages: graphStages, source: "graph" };
  }
  return { stages: defaultAgenticStages(prompt, override), source: "default" };
}

// "Build me X" — only run the full pipeline for clearly buildable requests.
// Questions ABOUT past builds ("What was the name of the site I asked you to
// create?") must never trigger a rebuild.
//
// This regex is now used only as an *imperative-build-intent confirmation*
// (kept for legacy sample/offline routing) — the primary signal is the
// router's own task_type, via shouldRunBuildPipeline below.
function hasImperativeBuildIntent(prompt: string): boolean {
  return (
    /\b(build|make|create|design|generate|develop|code|compile|scaffold|implement|assemble|combine|set ?up)\b/i.test(prompt) &&
    /\b(site|website|web ?app|webpage|web page|app|page|landing page|dashboard|tool|game|ui|front\s?end|interface|back\s?end|full[- ]?stack)\b/i.test(prompt)
  );
}

// task_type values from the router that plausibly mean "produce an artifact"
// (see src/shared/policy-contract.ts TaskType union): "coding" and
// "frontend_design" are the build-ish ones; summarisation/long_context/
// private_sensitive/general_chat never justify running the build pipeline.
const BUILD_TASK_TYPES: ReadonlySet<RouteDecision["task_type"]> = new Set(["coding", "frontend_design"]);

// Explicit manual override: typing "/orchestration" or "/orch" as the first
// token of the prompt forces the build pipeline unconditionally — it bypasses
// the router's task_type check, the opt-out/question guards, and the preview
// pre-gate. An explicit command always wins over inference.
const ORCHESTRATION_COMMAND_RE = /^\s*\/(orchestration|orch)\b\s*(.*)$/is;

interface OrchestrationCommandMatch {
  /** The remainder of the prompt after the command token, trimmed. May be
   *  empty when the user typed just "/orchestration" with nothing after it. */
  remainder: string;
}

function parseOrchestrationCommand(prompt: string): OrchestrationCommandMatch | null {
  const match = ORCHESTRATION_COMMAND_RE.exec(prompt);
  if (!match) return null;
  return { remainder: match[2].trim() };
}

// "Set up a preview / serve the site" is an operational request on the
// EXISTING project, not a build. Requires an explicit serve-ish verb near a
// preview/server word, and yields to genuine build phrasing.
function wantsProjectPreview(prompt: string): boolean {
  if (!/\b(set\s?up|start|open|launch|show|run|host|give me)\b[\s\S]{0,50}\b(preview|serve|server|localhost)\b/i.test(prompt)) return false;
  return !/\b(build|creat|mak\w|generat|design|develop|cod\w|implement|scaffold)\w*\b/i.test(prompt);
}

/** Serves the selected project folder on the shared static preview server and
 *  returns a lightweight run whose outputUrl opens the preview rail. */
async function runPreviewRequest(args: {
  input: SessionRunInput;
  prompt: string;
  conversationId: string;
  createdAt: string;
  promptHash: string;
  decision: PolicyDecisionResult;
  stream?: SessionStreamController;
}): Promise<SessionRun> {
  const { input, prompt, conversationId, createdAt, promptHash, decision, stream } = args;
  const writable = await resolveActiveProjectWorkspace(input.projectPath);
  const steps: SessionPipelineStep[] = [
    { id: "route", label: "Route through Metis Policy", detail: "Recognized a preview request for the current project.", status: "complete" }
  ];
  let assistantText: string;
  let outputUrl: string | undefined;
  const warnings: string[] = [];
  const operations: AgentOperation[] = [];
  if (!writable) {
    assistantText = "No project folder is selected (or its permission lapsed), so there is nothing to serve yet. Pick a project folder and ask again.";
    warnings.push("Preview request received without a writable project workspace.");
    steps.push({ id: "serve", label: "Start preview server", detail: "Skipped — no project folder.", status: "skipped" });
  } else {
    emitTimeline(stream, timelineText(`Starting a preview server for ${writable.name}.`));
    try {
      outputUrl = await ensureStaticPreview(writable.path);
      assistantText = `Preview is up for ${writable.name}: ${outputUrl} — it should open in the preview rail on the right. It serves the folder as-is; rebuilds are not needed to see saved changes.`;
      steps.push({ id: "serve", label: "Start preview server", detail: `Serving ${writable.name} at ${outputUrl}.`, status: "complete" });
      operations.push({
        id: randomUUID(),
        kind: "browser_check",
        label: "Started preview server",
        target: outputUrl,
        url: outputUrl,
        status: "complete",
        permission: "network.web",
        detail: `Static server for ${writable.path}`
      });
      emitStream(stream, { kind: "operation", operation: operations[0] });
      emitTimeline(stream, { id: randomUUID(), kind: "operations", title: "Preview server", operationIds: [operations[0].id] });
      await appendAudit("info", "project.preview", `Preview server started for ${writable.name}.`, { url: outputUrl, root: writable.path });
    } catch (error) {
      assistantText = `I could not start the preview server for ${writable.name}: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(assistantText);
      steps.push({ id: "serve", label: "Start preview server", detail: "Failed to start.", status: "error" });
    }
  }
  const run: SessionRun = {
    id: randomUUID(),
    conversationId,
    createdAt,
    completedAt: new Date().toISOString(),
    promptSha256: promptHash,
    promptPreview: prompt.slice(0, 180),
    rawPromptStored: false,
    projectPath: writable?.path ?? input.projectPath,
    pipelineName: "Preview Pipeline",
    routeLabel: "Preview",
    decision,
    steps,
    assistantText,
    outputUrl,
    warnings
  };
  await appendRunToConversation(run, prompt);
  await writeSessionRun(run);
  emitStream(stream, { kind: "complete", run });
  return run;
}

// Folder-truth gate (owner's principle: check the folder first, edit by
// default): a non-empty project folder means EDIT unless the user explicitly
// asks for a from-scratch rebuild. This replaces the old isEditIntent
// keyword-sniffing gate, which only fired on edit-verb wording and defaulted
// to a destructive scratch rebuild for anything else (e.g. "add a contact
// page" used to trigger a full replan). Now the folder's actual contents
// decide, and a fresh build against a non-empty folder gets a loud warning
// instead of silently overwriting the user's work.
function wantsFreshBuild(prompt: string): boolean {
  return /\b(from scratch|brand new|start over|rebuild|replace (everything|it all)|completely new)\b/i.test(prompt);
}

// A modification request against an EXISTING project ("space out the header",
// "fix the nav", "add a contact section", "make the hero bigger"). Broad on
// verbs on purpose — the caller only consults it when the folder actually has
// files, and shouldRunBuildPipeline's opt-out/question guards run first, so a
// plain question like "what does the header do?" never trips it.
function isEditIntent(prompt: string): boolean {
  return /\b(fix|repair|change|update|tweak|adjust|edit|modify|revise|rework|restyle|refactor|rename|resize|reposition|realign|recolou?r|re-?colour|move|replace|swap|add|remove|delete|insert|improve|polish|clean\s?up|shorten|expand|space\s?out|align|cent(er|re)|make\s+(it|the|them)|give\s+(it|the))\b/i.test(prompt);
}

const EDIT_CONTEXT_MAX_FILES = 12;
const EDIT_CONTEXT_FILE_CAP = 8000;
const EDIT_CONTEXT_TOTAL_CAP = 48000;
const EDIT_CONTEXT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out"]);
const EDIT_CONTEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".jsx", ".svg", ".md"]);

/** Loads the existing project's source files (capped) so edit-mode stages see
 *  what is actually on disk instead of planning a replacement from nothing. */
async function readExistingProjectFiles(root: string): Promise<GeneratedFile[]> {
  const resolvedRoot = resolve(root);
  const collected: GeneratedFile[] = [];
  let total = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (collected.length >= EDIT_CONTEXT_MAX_FILES || depth > 2) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= EDIT_CONTEXT_MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!EDIT_CONTEXT_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!EDIT_CONTEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (entry.name === "package-lock.json" || entry.name.toUpperCase() === "METIS.MD") continue;
      const full = join(dir, entry.name);
      try {
        let content = await readFile(full, "utf8");
        if (content.length > EDIT_CONTEXT_FILE_CAP) content = `${content.slice(0, EDIT_CONTEXT_FILE_CAP)}\n/* [truncated] */`;
        if (total + content.length > EDIT_CONTEXT_TOTAL_CAP) return;
        total += content.length;
        collected.push({ path: full.slice(resolvedRoot.length + 1).replace(/\\/g, "/"), content });
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  await walk(resolvedRoot, 0);
  return collected;
}

/** Cheap presence check for shouldRunBuildPipeline's edit-intent rule — does
 *  the folder actually have eligible source files, without reading any file
 *  contents? Mirrors readExistingProjectFiles' skip-dir/extension rules and
 *  depth cap, but returns on the very first match instead of collecting. */
async function projectHasSourceFiles(root: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 2) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EDIT_CONTEXT_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          if (await walk(join(dir, entry.name), depth + 1)) return true;
        }
        continue;
      }
      if (!EDIT_CONTEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (entry.name === "package-lock.json" || entry.name.toUpperCase() === "METIS.MD") continue;
      return true;
    }
    return false;
  }
  return walk(resolvedRoot, 0);
}

/** Check-first summary line (owner's principle: an ongoing-work tool must
 *  look at the folder before deciding create-vs-edit, not guess from prompt
 *  wording). Called for EVERY build-branch run against a writable workspace,
 *  before the create-vs-edit decision — "N files — index.html present" style,
 *  or "empty folder" when nothing was found. */
function projectCheckSummary(files: GeneratedFile[]): string {
  if (files.length === 0) return "empty folder";
  const hasIndexHtml = files.some((file) => /(^|\/)index\.html$/i.test(file.path));
  const base = `${files.length} file${files.length === 1 ? "" : "s"}`;
  return hasIndexHtml ? `${base} — index.html present` : base;
}

// --- Knowledge Banks phase 1: local embeddings retrieval (docs/FABLE_PLANS.md
// §16). STRICTLY ADDITIVE and a no-op whenever Ollama/the embed model/the
// project files/the retrieval result are unavailable — every function here
// fails soft (returns null/[] on any error) so a broken embed can never break
// a run. Uses the same OLLAMA_BASE_URL as the rest of the app (see the Ollama
// vision-RAG section below); this section is defined earlier in the file so
// it's usable by the edit/chat prompt-assembly sites above, which run later
// at runtime regardless of source order.
const KNOWLEDGE_EMBED_MODEL = "nomic-embed-text";
const KNOWLEDGE_MAX_CHUNKS = 200;
const KNOWLEDGE_CHUNK_SIZE = 1500;
const KNOWLEDGE_TOP_K = 4;
const KNOWLEDGE_SIMILARITY_FLOOR = 0.3;
const KNOWLEDGE_CONTEXT_CHAR_CAP = 6000;

type KnowledgeChunk = { path: string; ordinal: number; text: string };
type KnowledgeIndexedChunk = KnowledgeChunk & { vector: number[] };
type KnowledgeIndex = { signature: string; model: string; chunks: KnowledgeIndexedChunk[] };
type RetrievedKnowledgeChunk = { path: string; ordinal: number; text: string; score: number };

/** Embeds a batch of texts via Ollama's /api/embeddings, one request per text
 *  (simplest, works with any Ollama version). Returns null on ANY failure —
 *  unreachable server, missing model, malformed response — so callers can
 *  treat embeddings as simply "unavailable" and no-op. */
async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const vectors: number[][] = [];
    for (const text of texts) {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: KNOWLEDGE_EMBED_MODEL, prompt: text })
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { embedding?: number[] };
      if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) return null;
      vectors.push(payload.embedding);
    }
    return vectors;
  } catch {
    return null;
  }
}

/** Splits a file's text into ~KNOWLEDGE_CHUNK_SIZE-char chunks on paragraph
 *  (blank-line) boundaries where possible, falling back to line boundaries,
 *  so chunks stay deterministic and readable. */
function chunkFileText(path: string, content: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const paragraphs = content.split(/\n{2,}/);
  let buffer = "";
  let ordinal = 0;
  const flush = (): void => {
    const trimmed = buffer.trim();
    if (trimmed.length > 0) {
      chunks.push({ path, ordinal, text: trimmed });
      ordinal += 1;
    }
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > KNOWLEDGE_CHUNK_SIZE) {
      // A single oversized paragraph — fall back to line-by-line packing.
      flush();
      const lines = paragraph.split("\n");
      let lineBuffer = "";
      for (const line of lines) {
        if (lineBuffer.length + line.length + 1 > KNOWLEDGE_CHUNK_SIZE) {
          if (lineBuffer.trim().length > 0) {
            chunks.push({ path, ordinal, text: lineBuffer.trim() });
            ordinal += 1;
          }
          lineBuffer = "";
        }
        lineBuffer += `${line}\n`;
      }
      if (lineBuffer.trim().length > 0) {
        chunks.push({ path, ordinal, text: lineBuffer.trim() });
        ordinal += 1;
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > KNOWLEDGE_CHUNK_SIZE) flush();
    buffer += `${paragraph}\n\n`;
  }
  flush();
  return chunks;
}

/** Cheap, order-independent signature over the project's source files (path +
 *  size + mtime), used to decide whether a cached knowledge index is still
 *  fresh without re-reading file contents. */
async function knowledgeSourceSignature(root: string, files: GeneratedFile[]): Promise<string> {
  const resolvedRoot = resolve(root);
  const parts: string[] = [];
  for (const file of files) {
    try {
      const info = await stat(join(resolvedRoot, file.path));
      parts.push(`${file.path}:${info.size}:${info.mtimeMs}`);
    } catch {
      parts.push(`${file.path}:${file.content.length}`);
    }
  }
  return sha256(parts.sort().join("|"));
}

function knowledgeCachePath(root: string): string {
  return dataPath("knowledge", `${sha256(resolve(root))}.json`);
}

/** Builds (or reuses a cached) local embeddings index over the selected
 *  project's files. Returns null whenever there is nothing to index or
 *  embedding is unavailable — callers must treat null as "no knowledge bank"
 *  and change nothing about the run. Never throws. */
async function buildOrLoadKnowledgeIndex(root: string): Promise<KnowledgeIndex | null> {
  try {
    const files = await readExistingProjectFiles(root);
    if (files.length === 0) return null;
    const signature = await knowledgeSourceSignature(root, files);
    const cachePath = knowledgeCachePath(root);
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as KnowledgeIndex;
      if (cached.signature === signature && cached.model === KNOWLEDGE_EMBED_MODEL && Array.isArray(cached.chunks)) {
        return cached;
      }
    } catch {
      /* no usable cache — fall through to (re)build */
    }
    const allChunks: KnowledgeChunk[] = [];
    for (const file of files) {
      for (const chunk of chunkFileText(file.path, file.content)) {
        if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
        allChunks.push(chunk);
      }
      if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
    }
    if (allChunks.length === 0) return null;
    const vectors = await embedTexts(allChunks.map((chunk) => chunk.text));
    if (!vectors || vectors.length !== allChunks.length) return null;
    const index: KnowledgeIndex = {
      signature,
      model: KNOWLEDGE_EMBED_MODEL,
      chunks: allChunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))
    };
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(index), "utf8");
    } catch {
      /* cache write failure is non-fatal — the index is still usable this run */
    }
    return index;
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Retrieves the top-K most relevant chunks from the project's knowledge
 *  index for `query`. Returns [] on ANY failure or when the index/embedding
 *  is unavailable, or when nothing clears the similarity floor — [] is the
 *  required no-op signal for callers (no prompt change, no operation line). */
async function retrieveKnowledge(root: string, query: string, topK: number = KNOWLEDGE_TOP_K): Promise<RetrievedKnowledgeChunk[]> {
  try {
    const index = await buildOrLoadKnowledgeIndex(root);
    if (!index || index.chunks.length === 0) return [];
    const queryVectors = await embedTexts([query]);
    if (!queryVectors || queryVectors.length === 0) return [];
    const queryVector = queryVectors[0];
    const scored = index.chunks
      .map((chunk) => ({ path: chunk.path, ordinal: chunk.ordinal, text: chunk.text, score: cosineSimilarity(queryVector, chunk.vector) }))
      .filter((chunk) => chunk.score >= KNOWLEDGE_SIMILARITY_FLOOR)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch {
    return [];
  }
}

/** Formats retrieved chunks into a labelled context block for prompt
 *  prepending, capped to KNOWLEDGE_CONTEXT_CHAR_CAP total characters. Returns
 *  "" when given no chunks (callers should also just skip in that case). */
function knowledgeContextBlock(chunks: RetrievedKnowledgeChunk[]): string {
  if (chunks.length === 0) return "";
  let body = chunks.map((chunk) => `# ${chunk.path}\n${chunk.text}`).join("\n\n");
  if (body.length > KNOWLEDGE_CONTEXT_CHAR_CAP) body = `${body.slice(0, KNOWLEDGE_CONTEXT_CHAR_CAP)}\n/* [truncated] */`;
  return `Relevant project context (retrieved from the knowledge bank — cite/stay grounded in this, do not contradict it):\n\n${body}\n\n`;
}

/** Builds the "Grounded on N chunks" AgentOperation for a successful
 *  retrieval. Callers only build/emit this when chunks.length > 0 — an empty
 *  retrieval must never produce an operation line. */
function knowledgeGroundingOperation(root: string, chunks: RetrievedKnowledgeChunk[]): AgentOperation {
  const distinctFiles = Array.from(new Set(chunks.map((chunk) => chunk.path)));
  return {
    id: randomUUID(),
    kind: "context_load",
    label: `Grounded on ${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`,
    target: root,
    status: "complete",
    charCount: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    permission: "filesystem.read",
    detail: distinctFiles.join(", ").slice(0, 400)
  };
}

/** Single entry point for the prompt-assembly sites: retrieves knowledge for
 *  `query` against the project at `root` (honouring the knowledgeBankEnabled
 *  store toggle), and returns both the context block to prepend and the
 *  operation to emit — or null when there is nothing to ground on (the
 *  required no-op path: unchanged prompt, no operation, no timeline line). */
async function retrieveKnowledgeForPrompt(root: string | undefined, query: string): Promise<{ block: string; operation: AgentOperation } | null> {
  if (!root) return null;
  try {
    const knowledgeEnabled = await readStoreValue<boolean>("knowledgeBankEnabled", true);
    if (!knowledgeEnabled) return null;
    const chunks = await retrieveKnowledge(root, query);
    if (chunks.length === 0) return null;
    const block = knowledgeContextBlock(chunks);
    if (!block) return null;
    return { block, operation: knowledgeGroundingOperation(root, chunks) };
  } catch {
    return null;
  }
}

// --- Knowledge Banks phase 2: local embeddings retrieval over past
// conversations (docs/DRILL_PLAN.md Phase 6 §16 phase 2), mirroring the
// phase 1 file-retrieval code path directly above. STRICTLY ADDITIVE and a
// no-op whenever Ollama/the embed model/conversations/the retrieval result
// are unavailable — every function here fails soft (returns null/[] on any
// error) so a broken embed can never break a run. Not wired into any
// prompt-assembly site yet — only reachable via the
// metis-knowledge:searchConversations IPC handle, for a renderer follow-up
// (retrieve-into-chat UI, per-bank surfacing) to build on.
type RetrievedConversationChunk = { conversationId: string; ordinal: number; text: string; score: number };

/** Splits a conversation's turns into KnowledgeChunk-shaped items. Chunks on
 *  message boundaries first (each turn is its own logical unit), then
 *  sub-chunks any single turn whose content exceeds KNOWLEDGE_CHUNK_SIZE
 *  using chunkFileText's paragraph/line packer. Empty turns are skipped. */
function conversationToChunks(conversation: ConversationRecord): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let ordinal = 0;
  for (const turn of conversation.turns) {
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    const text = turn.content.trim();
    if (text.length === 0) continue;
    if (text.length <= KNOWLEDGE_CHUNK_SIZE) {
      chunks.push({ path: `conversation:${conversation.id}#${ordinal}`, ordinal, text });
      ordinal += 1;
      continue;
    }
    for (const sub of chunkFileText(`conversation:${conversation.id}`, text)) {
      chunks.push({ path: `conversation:${conversation.id}#${ordinal}`, ordinal, text: sub.text });
      ordinal += 1;
    }
  }
  return chunks;
}

/** Cheap, order-independent signature over the stored conversation set (id +
 *  message count + last-updated per conversation), used to decide whether a
 *  cached conversation index is still fresh without re-embedding everything.
 *  Mirrors knowledgeSourceSignature above. */
function conversationIndexSignature(conversations: ConversationRecord[]): string {
  const parts = conversations.map((conversation) => `${conversation.id}:${conversation.turns.length}:${conversation.updatedAt}`);
  return sha256(parts.sort().join("|"));
}

function conversationIndexCachePath(): string {
  return dataPath("knowledge", "conversations.json");
}

/** Builds (or reuses a cached) local embeddings index over stored
 *  conversations. Returns null whenever there is nothing to index or
 *  embedding is unavailable — callers must treat null as "no knowledge bank"
 *  and change nothing about the run. Never throws. Mirrors
 *  buildOrLoadKnowledgeIndex above exactly, at a distinct cache path so the
 *  two indexes never collide. */
async function buildOrLoadConversationIndex(): Promise<KnowledgeIndex | null> {
  try {
    const conversations = await readConversations();
    if (conversations.length === 0) return null;
    const signature = conversationIndexSignature(conversations);
    const cachePath = conversationIndexCachePath();
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as KnowledgeIndex;
      if (cached.signature === signature && cached.model === KNOWLEDGE_EMBED_MODEL && Array.isArray(cached.chunks)) {
        return cached;
      }
    } catch {
      /* no usable cache — fall through to (re)build */
    }
    const allChunks: KnowledgeChunk[] = [];
    for (const conversation of conversations) {
      for (const chunk of conversationToChunks(conversation)) {
        if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
        allChunks.push(chunk);
      }
      if (allChunks.length >= KNOWLEDGE_MAX_CHUNKS) break;
    }
    if (allChunks.length === 0) return null;
    const vectors = await embedTexts(allChunks.map((chunk) => chunk.text));
    if (!vectors || vectors.length !== allChunks.length) return null;
    const index: KnowledgeIndex = {
      signature,
      model: KNOWLEDGE_EMBED_MODEL,
      chunks: allChunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))
    };
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(index), "utf8");
    } catch {
      /* cache write failure is non-fatal — the index is still usable this run */
    }
    return index;
  } catch {
    return null;
  }
}

/** Retrieves the top-K most relevant chunks from the conversation knowledge
 *  index for `query`, building/loading the index lazily on first call (never
 *  auto-built at startup). Returns [] on ANY failure or when the
 *  index/embedding is unavailable, or when nothing clears the similarity
 *  floor — mirrors retrieveKnowledge above exactly. */
async function retrieveConversationContext(query: string, topK: number = KNOWLEDGE_TOP_K): Promise<RetrievedConversationChunk[]> {
  try {
    const index = await buildOrLoadConversationIndex();
    if (!index || index.chunks.length === 0) return [];
    const queryVectors = await embedTexts([query]);
    if (!queryVectors || queryVectors.length === 0) return [];
    const queryVector = queryVectors[0];
    const scored = index.chunks
      .map((chunk) => ({
        conversationId: chunk.path.replace(/^conversation:/, "").split("#")[0],
        ordinal: chunk.ordinal,
        text: chunk.text,
        score: cosineSimilarity(queryVector, chunk.vector)
      }))
      .filter((chunk) => chunk.score >= KNOWLEDGE_SIMILARITY_FLOOR)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch {
    return [];
  }
}

// Gate for the full multi-stage build pipeline. Router judgement
// (decision.task_type) is now the SOLE signal for the non-forced path — no
// more regex-sniffing the prompt for imperative build verbs. That keyword
// heuristic was too eager/too narrow in equal measure; the router's task_type
// classification (coding/frontend_design) is trusted directly, gated only by
// the opt-out/question guards below. A status question like "Without
// generating anything, what's the status of my website file?" is still kept
// out by isBuildOptOut/isBuildQuestionGuard, not by keyword-sniffing.
function shouldRunBuildPipeline(prompt: string, decision: RouteDecision, decisionSource: PolicyDecisionResult["source"], editableProject: boolean): boolean {
  if (isBuildOptOut(prompt)) return false;
  if (isBuildQuestionGuard(prompt)) return false;

  // An edit request against a folder that already has files always runs the
  // (edit branch of the) pipeline, even when the router labels it general_chat —
  // otherwise "space out the header" on a real project falls through to plain
  // chat and nothing gets edited. The folder-truth gate downstream then sends it
  // to the non-destructive edit stage (no replan, no new design seed).
  if (editableProject && isEditIntent(prompt)) return true;

  if (decisionSource === "sample") {
    // Offline/sample mode: decision.task_type is a canned placeholder, not a
    // real router judgement (see decidePolicy's offline fallback), so it
    // carries no signal here. Keep the legacy imperative-build regex as the
    // only available heuristic for this offline case (guards above already
    // applied).
    return hasImperativeBuildIntent(prompt);
  }

  // Live router decision: task_type alone is the signal now.
  return BUILD_TASK_TYPES.has(decision.task_type);
}

// Bug L4b: a trivial "Test"/"hi" turn was paying for a full project-snapshot
// walk + knowledge-bank retrieval before the model ever saw the prompt — real
// latency for a message that needed neither. This gate is deliberately
// narrow: only task_type general_chat, only a short prompt, and only when the
// prompt shows no build/edit/frontend intent, so a genuine question or build
// request is never affected — those all fail at least one check below.
const FAST_LANE_MAX_PROMPT_CHARS = 80;

function isFastLaneEligible(prompt: string, decision: RouteDecision): boolean {
  if (decision.task_type !== "general_chat") return false;
  if (prompt.trim().length > FAST_LANE_MAX_PROMPT_CHARS) return false;
  if (hasImperativeBuildIntent(prompt)) return false;
  if (isEditIntent(prompt)) return false;
  if (shouldRunFrontendTools(prompt, decision)) return false;
  return true;
}

function shouldStreamRouteCeremony(prompt: string, decision: RouteDecision, includeProjectTools: boolean, projectCommandOperations: AgentOperation[]): boolean {
  if (includeProjectTools || projectCommandOperations.length > 0) return true;
  if (decision.task_type !== "general_chat") return true;
  return /\b(route|routing|pipeline|orchestrat|why did you choose|what model|which model|trace)\b/i.test(prompt);
}

// Pull real files out of the build stages' code blocks, using any `filename`
// hint in the surrounding text, else inferring from the code fence language.
function extractProjectFiles(stages: OrchestrationStage[]): GeneratedFile[] {
  const byPath = new Map<string, string>();
  for (const stage of stages) {
    for (const file of extractGeneratedFilesFromText(stage.output ?? "")) {
      byPath.set(file.path, file.content);
    }
  }
  return Array.from(byPath.entries()).map(([path, content]) => ({ path, content }));
}

async function writeProjectFiles(files: GeneratedFile[], workspace: ProjectWorkspace | null, options: { singleFile?: boolean } = {}): Promise<ProjectToolResult> {
  const root = workspace ? workspace.path : dataPath("generated-projects", `${Date.now()}-build`);
  const prepared = prepareGeneratedFilesForPreview(files, options);
  return buildProjectToolResult(root, workspace, prepared.files, workspace ? `Project: ${workspace.name}` : "Generated project", prepared.notes);
}

/** DORMANT/DEPRECATED (docs/FABLE_PLANS.md section 25 update): default
 *  gateways used to be a Settings-level "route models from this HOME provider
 *  via this OTHER provider by default" map, configured in the now-removed
 *  Settings "Default gateways" panel. Gateways are now configured per node
 *  (NodeInspector's "Gateway" + "Gateway fallbacks" controls), which is a
 *  strictly richer replacement — nothing in the renderer writes to the
 *  "defaultGateways" store key anymore. This lookup is kept only as a last-
 *  resort fallback in expandStageRef for any pre-existing "defaultGateways"
 *  store value a user may still have on disk from before this change; it can
 *  be deleted entirely once that's no longer a concern. Fails soft to {}. */
async function getDefaultGateways(): Promise<Partial<Record<ProviderKey, ProviderKey>>> {
  return readStoreValue<Partial<Record<ProviderKey, ProviderKey>>>("defaultGateways", {});
}

/** Route-before-model fallback (docs/FABLE_PLANS.md section 21, extended by
 *  section 25's per-node gateway + gateway-fallback chain): given one
 *  {provider, model} stage entry, looks it up in the cached model catalog
 *  and, if the catalog knows this exact provider+model as one of a model's
 *  access routes, returns ALL of that model's routes as StageModelRefs,
 *  ordered so a rate-limited NVIDIA route falls through to the deepseek API
 *  route of the SAME model before the chain ever moves on to a different
 *  model. When the ref isn't found in the catalog (or the catalog is empty),
 *  returns the ref unchanged as a single-entry array — callers always get at
 *  least one StageModelRef back.
 *
 *  Route order (section 25): explicit `preference` (a node's ordered
 *  [gateway, ...gatewayFallbacks] list) comes FIRST, in that exact order,
 *  filtered to routes the model actually has and is configured for —
 *  regardless of cooldown state (a cooling preferred route still gets tried
 *  in its preferred slot; the existing cooldown-skip logic in
 *  callStageWithFallback is what actually skips it at call time, not this
 *  ordering step). Falls back to `defaultGateways[model's home provider]`
 *  (dormant/deprecated single-pin store value, see getDefaultGateways) only
 *  when no `preference` is given. After the preference list, the model's
 *  remaining routes follow the existing healthy-first ordering: first
 *  configured-and-not-cooling, then configured-but-cooling, then
 *  unconfigured. An unconfigured preferred route is dropped from the
 *  preference list (never jumps the queue), same as before. */
async function expandStageRef(ref: StageModelRef, preference?: ProviderKey[]): Promise<StageModelRef[]> {
  const catalog = await listModelCatalog();
  const model = catalog.models.find((entry) => (entry.access ?? []).some((route) => route.provider === ref.provider && route.id === ref.model));
  if (!model || !model.access || model.access.length === 0) return [ref];

  let effectivePreference = preference ?? [];
  if (effectivePreference.length === 0) {
    const defaultGateway = (await getDefaultGateways())[model.provider];
    if (defaultGateway) effectivePreference = [defaultGateway];
  }

  const configuredFlags = await Promise.all(model.access.map((route) => isProviderConfigured(route.provider)));
  // Key POOLS (docs/DRILL_PLAN.md Phase 6): resync each route provider's
  // legacy cooldown entry from its pooled accounts before the isProviderCooling
  // ordering read below, so a provider with one still-usable account isn't
  // pushed behind the "configured but cooling" bucket it no longer belongs in.
  await Promise.all(
    model.access.map(async (route) => {
      const accounts = await effectiveAccountsForProvider(route.provider);
      await syncProviderCooldownFromAccounts(route.provider, accounts);
    })
  );
  const withStatus = model.access.map((route, index) => ({ route, configured: configuredFlags[index], cooling: isProviderCooling(route.provider) }));

  // Preference entries win a slot in EXPLICIT order, each only once, and only
  // when the model actually has that route AND it's configured.
  const preferredEntries: typeof withStatus = [];
  const claimed = new Set<typeof withStatus[number]>();
  for (const providerPref of effectivePreference) {
    const entry = withStatus.find((candidate) => candidate.route.provider === providerPref && candidate.configured && !claimed.has(candidate));
    if (entry) {
      preferredEntries.push(entry);
      claimed.add(entry);
    }
  }
  const rest = withStatus.filter((entry) => !claimed.has(entry));
  const healthy = rest.filter((entry) => entry.configured && !entry.cooling);
  const configuredButCooling = rest.filter((entry) => entry.configured && entry.cooling);
  const unconfigured = rest.filter((entry) => !entry.configured);
  const ordered = [...preferredEntries, ...healthy, ...configuredButCooling, ...unconfigured];

  return ordered.map((entry) => ({ provider: entry.route.provider, model: entry.route.id }));
}

/** Expands every entry of a stage chain through expandStageRef and dedupes the
 *  result by provider+model, preserving first-seen order — so a chain of
 *  MODELS (e.g. [nvidia/deepseek-v3.1, anthropic/claude]) becomes a chain of
 *  ROUTES that tries every access route of the first model before moving on to
 *  the second model's routes (docs/FABLE_PLANS.md section 21).
 *
 *  `primaryPreference` (docs/FABLE_PLANS.md section 25) is a node's ordered
 *  [gateway, ...gatewayFallbacks] list (generalized from the old single
 *  "Access via" pin) — it only ever applies to the chain's FIRST entry (the
 *  stage's own primary model), never to fallback entries, which keep
 *  resolving through their own defaultGateways/health ordering. */
async function expandChainByRoutes(chain: StageModelRef[], primaryPreference?: ProviderKey[]): Promise<StageModelRef[]> {
  const expandedGroups = await Promise.all(chain.map((ref, index) => expandStageRef(ref, index === 0 ? primaryPreference : undefined)));
  const seen = new Set<string>();
  const result: StageModelRef[] = [];
  for (const group of expandedGroups) {
    for (const ref of group) {
      const key = `${ref.provider}|${ref.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(ref);
    }
  }
  return result;
}

/** Optional stage identity + stream threaded through to callStageWithFallback
 *  purely so it can emit `stage_call` side-chat events (docs/FABLE_PLANS.md
 *  §26) — every model call becomes a visible card in the renderer's side-chat
 *  stack. Callers that don't have a stage identity handy (or no stream) can
 *  simply omit this and no events emit; it never affects control flow. */
type StageCallContext = {
  stream?: SessionStreamController;
  stageId: string;
  stageLabel: string;
  scope?: string;
  /** Named sub-agent this call belongs to (docs/DRILL_PLAN.md Phase 5,
   *  sub-round 5a — the fan-out engine). Threaded straight into every
   *  stage_call event's `agentName` field below; omitted (undefined) for
   *  every ordinary single-pipeline call, unchanged from before this field
   *  existed. */
  agentName?: string;
};

async function callStageWithFallback(
  rawChain: StageModelRef[],
  prompt: string,
  primaryPreference?: ProviderKey[],
  callContext?: StageCallContext,
  images?: ProviderImageInput[]
): Promise<{ ref: StageModelRef; output: string; notes: string[]; failed: boolean }> {
  const notes: string[] = [];
  // Route-before-model fallback (docs/FABLE_PLANS.md §21, extended by §25's
  // per-node Gateway + Gateway fallbacks chain via primaryPreference): expand
  // each chain entry to every access route of its catalog model (if known)
  // before the existing "Never Run Dry" cooldown-skip logic below runs — so a
  // cooling route rotates to a sibling route of the SAME model first, and
  // only moves to the next model once every route of the current one is
  // exhausted. Rotation/cooldown notes below are unaffected: they're keyed by
  // provider, same as before expansion.
  const chain = await expandChainByRoutes(rawChain, primaryPreference);
  // "Never Run Dry" quota rotation (docs/FABLE_PLANS.md §19), extended by Key
  // POOLS (docs/DRILL_PLAN.md Phase 6, §19 phase 2): a provider still cooling
  // from a recent 429/quota failure is skipped outright rather than burning
  // another call against it — but "cooling" now means ALL of that provider's
  // pooled accounts are cooling, not just its one classic key. `next` for the
  // rotation note looks ahead to the next CHAIN entry (a different
  // provider/model) that isn't ALSO cooling, so the note names where we're
  // actually headed once this provider's whole account pool is exhausted.
  for (let i = 0; i < chain.length; i++) {
    const ref = chain[i];
    // Resolve this provider's account pool (real pool if configured, else the
    // single implicit back-compat account, else [] for ollama/unconfigured)
    // and resync the legacy per-provider cooldown map from it before any
    // isProviderCooling read below — same pattern as resolveModelRoute/
    // expandStageRef/listProviders/healthCheckProvider above.
    const accounts = await effectiveAccountsForProvider(ref.provider);
    await syncProviderCooldownFromAccounts(ref.provider, accounts);
    const isPooled = accounts.length > 1;

    const nextViable = chain.slice(i + 1).find((candidate) => !isProviderCooling(candidate.provider));
    if (isProviderCooling(ref.provider)) {
      const until = providerCooldownUntil(ref.provider)!;
      notes.push(
        `${stageModelLabel(ref)} is rate-limited (cooling ${formatCooldownDuration(until)})${nextViable ? ` — rotated to ${stageModelLabel(nextViable)}.` : "."}`
      );
      continue;
    }
    const next = chain[i + 1];

    // Intra-provider account rotation (docs/DRILL_PLAN.md Phase 6): for a
    // pooled provider, try each non-cooling account (least-recently-used
    // first) before this chain entry is considered exhausted and the outer
    // loop advances to the next provider/model. For ollama or a provider with
    // zero/one account, this is a single [undefined]/[implicit-account]
    // iteration — byte-identical to the pre-pool call path below.
    const candidateAccounts: Array<ProviderAccount | undefined> =
      ref.provider === "ollama" ? [undefined] : accounts.length > 0 ? orderAccountsForRotation(accounts) : [undefined];

    let attemptResult: { ref: StageModelRef; output: string; notes: string[]; failed: false } | undefined;

    for (let a = 0; a < candidateAccounts.length; a++) {
      const account = candidateAccounts[a];
      const attemptLabel = isPooled && account ? `${stageModelLabel(ref)} (${account.label ?? account.id})` : stageModelLabel(ref);
      const nextAccount = candidateAccounts[a + 1];
      const rotateHint = nextAccount
        ? ` — rotated to ${stageModelLabel(ref)} (${nextAccount.label ?? nextAccount.id}).`
        : next
          ? ` — rotated to ${stageModelLabel(next)}.`
          : ".";

      // Side-chat card (docs/FABLE_PLANS.md §26): each ATTEMPT (not each
      // skipped cooling entry) gets its own call id, so a fallback rotation
      // renders as a failed card followed by a fresh card for the next
      // attempt — including a same-provider account-to-account rotation.
      const callId = randomUUID();
      if (callContext?.stream) {
        emitStream(callContext.stream, {
          kind: "stage_call",
          call: {
            id: callId,
            stageId: callContext.stageId,
            stageLabel: callContext.stageLabel,
            provider: ref.provider,
            model: ref.model,
            promptPreview: prompt.slice(0, 200),
            prompt: prompt.slice(0, 2000),
            status: "start",
            agentName: callContext?.agentName
          }
        });
      }
      try {
        // Stage calls never stream (only the chat path does) — pass no stream
        // here, same as before this change; only the cancel scope + account
        // override are new.
        const result = await invokeProvider({ provider: ref.provider, model: ref.model, prompt, images }, undefined, callContext?.scope, account);
        if (result.source === "placeholder" || !result.output.trim()) {
          // Not a quota error (e.g. missing key, non-quota HTTP failure that
          // invokeProvider already downgraded to a placeholder) — no account
          // rotation for this case, same as the pre-pool behaviour: fall
          // through to the next CHAIN entry, not the next account.
          const note = `${attemptLabel} unavailable${next ? `, falling back to ${stageModelLabel(next)}` : ""}.`;
          notes.push(note);
          if (callContext?.stream) {
            emitStream(callContext.stream, {
              kind: "stage_call",
              call: {
                id: callId,
                stageId: callContext.stageId,
                stageLabel: callContext.stageLabel,
                provider: ref.provider,
                model: ref.model,
                promptPreview: prompt.slice(0, 200),
                status: "failed",
                detail: note,
                agentName: callContext?.agentName
              }
            });
          }
          break;
        }
        const trimmedOutput = result.output.trim();
        if (callContext?.stream) {
          emitStream(callContext.stream, {
            kind: "stage_call",
            call: {
              id: callId,
              stageId: callContext.stageId,
              stageLabel: callContext.stageLabel,
              provider: ref.provider,
              model: ref.model,
              promptPreview: prompt.slice(0, 200),
              status: "complete",
              output: trimmedOutput.slice(0, 4000),
              agentName: callContext?.agentName
            }
          });
        }
        attemptResult = { ref, output: trimmedOutput, notes, failed: false };
        break;
      } catch (error) {
        // A Stop-button abort must surface as cancellation, never as a
        // provider failure: rethrow immediately so the fallback chain never
        // rotates to the next model/account and repair/recovery never treats
        // this as "try again".
        if (isCancellationError(error)) throw error;
        if (isQuotaError(error)) {
          // Quota errors are exactly the case that rotates within this
          // provider's account pool first (docs/DRILL_PLAN.md Phase 6) —
          // invokeProvider already cooled down THIS account (or, with no
          // account override, the whole provider) and resynced the legacy
          // map; read it back for the note/duration.
          const until = account ? (accountCooldownUntil(account.id) ?? Date.now()) : (providerCooldownUntil(ref.provider) ?? Date.now());
          const note = `${attemptLabel} is rate-limited (cooling ${formatCooldownDuration(until)})${rotateHint}`;
          notes.push(note);
          if (callContext?.stream) {
            emitStream(callContext.stream, {
              kind: "stage_call",
              call: {
                id: callId,
                stageId: callContext.stageId,
                stageLabel: callContext.stageLabel,
                provider: ref.provider,
                model: ref.model,
                promptPreview: prompt.slice(0, 200),
                status: "failed",
                detail: note,
                agentName: callContext?.agentName
              }
            });
          }
          // Loop to the next candidate account of the SAME provider (if any)
          // before this chain entry is considered exhausted.
          continue;
        }
        const note = `Failed to call ${attemptLabel} (${error instanceof Error ? error.message : String(error)})${next ? `, falling back to ${stageModelLabel(next)}` : ""}.`;
        notes.push(note);
        if (callContext?.stream) {
          emitStream(callContext.stream, {
            kind: "stage_call",
            call: {
              id: callId,
              stageId: callContext.stageId,
              stageLabel: callContext.stageLabel,
              provider: ref.provider,
              model: ref.model,
              promptPreview: prompt.slice(0, 200),
              status: "failed",
              detail: note,
              agentName: callContext?.agentName
            }
          });
        }
        break;
      }
    }

    if (attemptResult) return attemptResult;
    // Every candidate account for this provider is now exhausted (all cooling
    // from quota errors, or a single non-quota failure) — the outer loop
    // advances to the next chain entry, same control flow as before pools.
  }
  if (chain.every((ref) => isProviderCooling(ref.provider))) {
    notes.push("Every model in this stage's chain is currently cooling down from a rate limit.");
  }
  return { ref: chain[chain.length - 1], output: "", notes: [...notes, "All models for this stage failed."], failed: true };
}

// --- N-agent fan-out build (docs/DRILL_PLAN.md Phase 5, sub-round 5a) ---
// Metis's answer to Traycer: a build request fans out to a handful of named
// sub-agents, each claiming a distinct file TERRITORY, coordinated by an
// in-memory file-claim ledger so two agents can never write the same path.
// v1 runs sub-agents SEQUENTIALLY under the hood (one staged call each) while
// tagging every stage_call with a distinct agentName, so the renderer can
// still present them as separate side-chat cards once 5c wires that up. This
// is entirely OFF by default (see shouldAttemptFanout's `fanoutEnabled`
// store-key read) — until Lachy opts in, every build behaves exactly as it
// did before this section existed. Any failure anywhere in this path falls
// back to the untouched single-pipeline runOrchestratedStages; a fan-out
// attempt can never make a build worse.

/** Mirrors MANAGED_AGENT_IDENTITIES' names from src/renderer/ui/App.tsx
 *  (renderer-side; deliberately NOT imported here — main.ts stays free of a
 *  renderer dependency). Sub-agents are assigned these in call order so the
 *  renderer's existing name -> hue lookup already knows how to color them
 *  once the 5c visualisation round lands. */
const FANOUT_AGENT_NAMES = ["Nyx", "Talos", "Echo", "Atlas", "Juno"] as const;

type FanoutTask = { name: string; task: string; territory: string[] };

/** Gate for fan-out mode (docs/DRILL_PLAN.md Phase 5, sub-round 5a): reads
 *  the opt-in `fanoutEnabled` store key (default FALSE — a stable default,
 *  never true until Lachy flips it) and never engages for a single-file
 *  request, which has nothing to fan out. When this returns false the caller
 *  runs the exact same runOrchestratedStages path that existed before fan-out
 *  was built, byte for byte. */
async function shouldAttemptFanout(singleFile: boolean): Promise<boolean> {
  if (singleFile) return false;
  return readStoreValue<boolean>("fanoutEnabled", false);
}

/** ONE cheap local planning call that tries to decompose a build prompt into
 *  2-4 sub-tasks, each owning a distinct file TERRITORY (concrete paths or
 *  globs). This is the "spec-first" step: every sub-agent's task doc line
 *  comes straight from this plan. Returns null — never throws — whenever the
 *  call fails, the reply can't be parsed as the expected JSON shape, or fewer
 *  than 2 usable tasks come back (a 1-task "decomposition" isn't a fan-out;
 *  the caller falls back to the normal single pipeline in that case, exactly
 *  as the spec requires: fan-out must never make a build worse). */
async function planFanoutTasks(prompt: string, stream: SessionStreamController | undefined, scope: string): Promise<FanoutTask[] | null> {
  const planPrompt = `You are the FAN-OUT PLANNER for a multi-agent build pipeline. Decompose this build request into 2 to 4 independent SUB-TASKS, each owned by one sub-agent and each claiming a DISTINCT set of file paths — no two sub-tasks should claim the same file.

Build request:
${prompt}

Respond with ONLY a JSON array, no prose, no code fences, in this exact shape:
[{"task":"one-line description of this sub-agent's job","files":["path/one.ext","path/two.ext"]}]

Rules: 2 to 4 entries. Each entry needs at least one file path. Split along natural boundaries (e.g. markup/styles vs backend/API vs config/docs vs a distinct feature area). If this request only really needs one small file, return a single-entry array — the caller will fall back to a normal single-pipeline build in that case.`;
  const planCallContext: StageCallContext = { stream, stageId: "fanout-plan", stageLabel: "Fan-out planner", scope };
  try {
    const attempt = await callStageWithFallback([localStageRef()], planPrompt, undefined, planCallContext);
    if (attempt.failed || !attempt.output.trim()) return null;
    const cleanOutput = stripThinkBlocks(attempt.output).trim();
    const jsonMatch = cleanOutput.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return null;
    const tasks: FanoutTask[] = parsed
      .filter(
        (entry): entry is { task: string; files: unknown[] } =>
          !!entry && typeof entry === "object" && typeof (entry as { task?: unknown }).task === "string" && Array.isArray((entry as { files?: unknown }).files) && (entry as { files: unknown[] }).files.length > 0
      )
      .slice(0, FANOUT_AGENT_NAMES.length)
      .map((entry, index) => ({
        name: FANOUT_AGENT_NAMES[index],
        task: String(entry.task).slice(0, 300),
        territory: entry.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0).map((file) => file.trim())
      }))
      .filter((entry) => entry.territory.length > 0);
    if (tasks.length < 2) return null;
    return tasks;
  } catch {
    return null;
  }
}

/** The file-claim LEDGER (docs/DRILL_PLAN.md Phase 5, sub-round 5a): a plain
 *  in-memory Map<path, agentName>, local to one fan-out run — nothing module-
 *  level, so there is nothing to ever leave "dirty" between runs. Sub-agents
 *  run in call order and each claims the paths it actually generated (not
 *  just its planned territory, since a model can drift outside its brief);
 *  the FIRST agent to reach a given path wins the claim. A later agent
 *  reaching an already-claimed path is rejected here and the caller must
 *  drop that file rather than overwrite it — this is what guarantees two
 *  sub-agents can never both write the same file. */
function claimFilePath(ledger: Map<string, string>, path: string, agentName: string): boolean {
  const existing = ledger.get(path);
  if (existing && existing !== agentName) return false;
  ledger.set(path, agentName);
  return true;
}

/** Runs the N-agent fan-out build (docs/DRILL_PLAN.md Phase 5, sub-round 5a —
 *  the engine; the visualisation is a later sub-round). Mirrors
 *  runOrchestratedStages' inputs/outputs closely enough that runSession can
 *  swap between the two with only a few extra lines: on success returns the
 *  merged, ledger-clean file list alongside a stages[] (one entry per sub-
 *  agent, for the existing timeline/step/audit rendering) and fanout roster
 *  metadata for SessionRun. Returns null on ANY failure or when planning
 *  didn't yield a usable multi-task split — callers must fall back to
 *  runOrchestratedStages in that case, never surface a fan-out error to the
 *  user as if it were a build failure. */
async function runFanoutPipeline(
  prompt: string,
  stream: SessionStreamController | undefined,
  override: SessionModelOverride | undefined,
  projectPath: string | undefined,
  metisFile: { content: string; chars: number } | null | undefined,
  conversationContext: string | null | undefined,
  images: ProviderImageInput[] | undefined
): Promise<{ stages: OrchestrationStage[]; designSeed: DesignSeed; fanout: NonNullable<SessionRun["fanout"]>; files: GeneratedFile[] } | null> {
  const scope = directiveScopeKey(projectPath);
  try {
    throwIfCancelled(projectPath);
    emitTimeline(stream, timelineText("Fan-out mode: decomposing this build across a small agent roster."));
    const tasks = await planFanoutTasks(prompt, stream, scope);
    if (!tasks) return null;

    const metisBlock = metisFilePromptBlock(metisFile ?? null);
    const seed = pickDesignSeed(prompt, 0);
    const explicitStyle = promptHasExplicitStyle(prompt);
    const planSummary = tasks.map((task) => `- ${task.name}: ${task.task} (owns: ${task.territory.join(", ")})`).join("\n");
    emitTimeline(stream, timelineText(`Plan: ${tasks.length} agents — ${tasks.map((task) => task.name).join(", ")}.`));

    // Reuse the SAME chain resolution the single pipeline uses (graph pipeline
    // if configured, else the hardcoded default) — sub-agents share the
    // front-end stage's chain/gateway preference rather than inventing a new
    // model-selection policy, so fan-out respects Lachy's existing routing.
    const { stages: baseStages } = await resolveAgenticStages(prompt, override);
    const sharedStage = baseStages.find((entry) => entry.templateRole === "frontend") ?? baseStages[0];
    const sharedChain = sharedStage?.chain ?? [localStageRef()];
    const gatewayPreference = sharedStage?.gatewayPreference;

    const ledger = new Map<string, string>();
    const resultStages: OrchestrationStage[] = [];
    const claimedFiles: GeneratedFile[] = [];
    const agentSummaries: { name: string; task: string; claimedPaths: string[] }[] = [];

    for (let index = 0; index < tasks.length; index++) {
      throwIfCancelled(projectPath);
      const subtask = tasks[index];
      emitTimeline(stream, timelineText(`${subtask.name} is starting: ${subtask.task}`));
      let subPrompt = `You are ${subtask.name}, one sub-agent in a multi-agent build team working on the SAME project. A fan-out planner split this build into ${tasks.length} parallel workstreams; you own exactly one of them.

Overall build request:
${prompt}

Team plan (context only — the OTHER agents own the other territories; do not duplicate their files):
${planSummary}

YOUR task (this is your spec — write only to your territory): ${subtask.task}
YOUR file territory (produce files ONLY at these paths, nothing outside it): ${subtask.territory.join(", ")}

Return COMPLETE files, not snippets, only for paths inside your territory. Before each fenced code block, put the file path in backticks on its own line. One short sentence of intro, then the files.`;
      if (metisBlock) subPrompt = `${metisBlock}\n${subPrompt}`;
      if (conversationContext) subPrompt = `Recent conversation (for continuity — the newest user request is the task):\n${conversationContext}\n\n${subPrompt}`;
      subPrompt += `\n\n${designSeedPromptLine(seed, { explicitStyle, replacesPrevious: false })}`;

      // Reference-image attachments (when present) only make sense for
      // whichever agent is doing the visual/front-end territory; handing them
      // to every agent would blow the shared MAX_ATTACHMENT_IMAGES budget for
      // no benefit, so only the FIRST agent gets them, same convention as the
      // single pipeline reserving images for the frontend stage.
      const subImages = index === 0 && images && images.length > 0 ? images : undefined;
      const callContext: StageCallContext = {
        stream,
        stageId: `fanout-${subtask.name.toLowerCase()}`,
        stageLabel: subtask.task.slice(0, 60) || subtask.name,
        scope,
        agentName: subtask.name
      };
      // Agent-to-agent bus (docs/DRILL_PLAN.md Phase 5b): pop any directive
      // addressed to THIS agent (or broadcast) before it runs, same absorption
      // pattern runOrchestratedStages uses for user steering. Directives
      // addressed to a different agent are left pending for their real target.
      const inboundDirectives = takePendingDirectives(projectPath, callContext.stageId, subtask.name);
      for (const directive of inboundDirectives) {
        const originLabel = directive.fromAgent ? `${directive.fromAgent}` : "the manager";
        emitTimeline(stream, timelineText(`${subtask.name} received a ${directive.kind ?? "steer"} from ${originLabel}: "${directive.text}"`));
        subPrompt += `\n\nDirection from ${originLabel} (arrived mid-run): ${directive.text}`;
      }
      const attempt = await callStageWithFallback(sharedChain, subPrompt, gatewayPreference, callContext, subImages);
      // Future agent step: once a sub-agent's own output signals it needs
      // input from a teammate or the manager (e.g. an "ASK:" tag it emits),
      // this is where it would call postAgentDirective({ projectPath,
      // fromAgent: subtask.name, toAgent: <other agent or "manager">, text,
      // kind: "question" | "review_request" | "handoff" }) to hand off. No
      // such trigger exists yet in this sequential v1 — this is the plumbing
      // + call point, not a live emit.

      const cleanOutput = stripAskUserTags(stripThinkBlocks(attempt.output));
      const stage: OrchestrationStage = {
        id: callContext.stageId,
        label: `${subtask.name} — ${subtask.task.slice(0, 40)}`,
        provider: attempt.ref.provider,
        model: attempt.ref.model,
        output: cleanOutput,
        fallbackNotes: attempt.notes,
        failed: attempt.failed
      };
      resultStages.push(stage);
      emitStream(stream, { kind: "stage", stage });

      const claimedPaths: string[] = [];
      if (!attempt.failed && cleanOutput.trim()) {
        for (const file of extractGeneratedFilesFromText(cleanOutput)) {
          // The claim check (docs/DRILL_PLAN.md Phase 5, sub-round 5a): the
          // first agent to reach a path wins it; a later agent producing the
          // SAME path is rejected and its file is dropped, never written —
          // this is the guarantee that stops two agents double-writing a file.
          if (claimFilePath(ledger, file.path, subtask.name)) {
            claimedFiles.push(file);
            claimedPaths.push(file.path);
          } else {
            emitTimeline(
              stream,
              timelineText(`${subtask.name} also produced ${file.path}, but ${ledger.get(file.path)} already claimed it — dropped ${subtask.name}'s copy to avoid a double-write.`)
            );
          }
        }
      }
      agentSummaries.push({ name: subtask.name, task: subtask.task, claimedPaths });
    }

    // Never leave the ledger dirty: it's local to this call and about to go
    // out of scope anyway, but clear it explicitly so intent is unambiguous.
    ledger.clear();

    if (claimedFiles.length === 0) return null; // nothing usable — fall back cleanly to the single pipeline

    emitTimeline(
      stream,
      timelineText(
        `Fan-out merge: ${agentSummaries.map((agent) => `${agent.name} (${agent.claimedPaths.length})`).join(", ")} — ${claimedFiles.length} file${claimedFiles.length === 1 ? "" : "s"} total.`
      )
    );

    return {
      stages: resultStages,
      designSeed: seed,
      fanout: { agents: agentSummaries },
      files: claimedFiles
    };
  } catch (error) {
    // A Stop-button abort must propagate exactly like it does everywhere else
    // in the build path — never swallowed into "fall back silently".
    if (isCancellationError(error)) throw error;
    return null;
  }
}

// --- "Is this done?" critic loop (docs/FABLE_PLANS.md §22) ---
// Local tokens are effectively free, so after a stage completes we can afford
// to auto-prompt a local critic model asking whether the output actually
// finished the task, and push the stage model to keep going when it didn't.
// This is what catches "the local model gave up halfway through the file".
const CRITIC_PASS_LIMIT = 4;

type CriticVerdict = { done: boolean; missing: string[] };

/** Calls the local model with a tight completeness-judging template and
 *  parses its verdict defensively. Never throws for an ordinary failure: any
 *  failure to reach the model or to parse its reply returns null, which
 *  callers treat as "skip critique" — the critic must never be able to turn a
 *  working stage into a failed one. The one exception is a Stop-button
 *  cancellation, which rethrows so it isn't silently swallowed into "skip". */
async function critiqueStageOutput(stageLabel: string, stagePrompt: string, output: string, scope?: string): Promise<CriticVerdict | null> {
  try {
    const taskSummary = stagePrompt.slice(0, 1500);
    const cappedOutput = output.slice(0, 6000);
    const criticPrompt = `You are a strict completeness critic for a build pipeline stage called "${stageLabel}".

TASK GIVEN TO THE MODEL:
${taskSummary}

OUTPUT PRODUCED:
${cappedOutput}

Judge ONLY whether the output fully completes the task above. For stages that produce files: are the files complete (not truncated, no "rest of code here" / "// ... continued" / "..." placeholders, no missing closing tags/braces)? Do not judge style or taste, only completeness.

Answer with ONLY JSON, nothing else, in this exact shape:
{ "done": true or false, "missing": ["short description of what's missing", ...] }

If it is complete, "missing" should be an empty array.`;
    const ref = localStageRef();
    const result = await invokeProvider({ provider: ref.provider, model: ref.model, prompt: criticPrompt }, undefined, scope);
    if (result.source === "placeholder" || !result.output.trim()) return null;
    const cleaned = stripThinkBlocks(result.output);
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { done?: unknown; missing?: unknown };
    if (typeof parsed.done !== "boolean") return null;
    const missing = Array.isArray(parsed.missing) ? parsed.missing.filter((item): item is string => typeof item === "string") : [];
    return { done: parsed.done, missing };
  } catch (error) {
    if (isCancellationError(error)) throw error;
    return null;
  }
}

/** Self-verify policy: local-provider stages always get critiqued (local
 *  tokens are free); cloud-provider stages only get critiqued when the user
 *  opted into "all". */
async function shouldSelfVerifyStage(ref: StageModelRef): Promise<boolean> {
  if (ref.provider === "ollama") return true;
  const selfVerify = await readStoreValue<"off" | "local" | "all">("selfVerify", "local");
  return selfVerify === "all";
}

/** Runs the critic loop against an already-completed stage attempt, re-calling
 *  the stage model chain with the missing-items list appended when the critic
 *  says the output isn't done yet. Returns the (possibly revised) output and
 *  how many critic passes actually ran. Fails soft at every step — a critic or
 *  re-call error just stops the loop and keeps the last good output. */
async function runCriticLoop(args: {
  stageLabel: string;
  stagePrompt: string;
  chain: StageModelRef[];
  ref: StageModelRef;
  output: string;
  stream?: SessionStreamController;
  gatewayPreference?: ProviderKey[];
  stageId?: string;
  images?: ProviderImageInput[];
  scope?: string;
}): Promise<{ output: string; criticPasses: number }> {
  const isLocalStage = args.ref.provider === "ollama";
  if (!(await shouldSelfVerifyStage(args.ref))) return { output: args.output, criticPasses: 0 };
  if (!args.output.trim()) return { output: args.output, criticPasses: 0 };

  const passLimit = isLocalStage ? CRITIC_PASS_LIMIT : 1;
  let currentOutput = args.output;
  let passes = 0;

  for (let i = 0; i < passLimit; i++) {
    const verdict = await critiqueStageOutput(args.stageLabel, args.stagePrompt, currentOutput, args.scope);
    if (verdict === null) break; // Unparseable/unreachable critic — skip, never block.
    if (verdict.done) break; // Silence when it passes first try — no timeline noise.

    passes++;
    const firstMissing = (verdict.missing[0] ?? "the rest of the task").trim();
    const trimmedMissing = firstMissing.length > 100 ? `${firstMissing.slice(0, 97)}...` : firstMissing;
    emitTimeline(args.stream, timelineText(`Self-check ${passes}: still missing ${trimmedMissing} — continuing.`));

    const missingList = verdict.missing.length > 0 ? verdict.missing.map((item) => `- ${item}`).join("\n") : "- (no specifics given, but the task is not finished)";
    const continuationPrompt = `${args.stagePrompt}\n\nYour previous output was incomplete. You MUST complete: \n${missingList}\n\nContinue and return the COMPLETE result (full files, not diffs).\n\nYour previous output:\n${currentOutput.slice(0, 8000)}`;

    const attempt = await callStageWithFallback(
      args.chain,
      continuationPrompt,
      args.gatewayPreference,
      args.stageId ? { stream: args.stream, stageId: args.stageId, stageLabel: args.stageLabel, scope: args.scope } : undefined,
      args.images
    );
    if (!attempt.failed && attempt.output.trim()) {
      currentOutput = stripThinkBlocks(attempt.output);
    }
  }

  return { output: currentOutput, criticPasses: passes };
}

// --- Design seeds (creativity as infrastructure; docs/FABLE_PLANS.md §1) ---

/** Simple deterministic string hash (djb2). Good enough for picking an index
 *  into a small curated bank — not a security hash. */
function djb2Hash(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** Deterministic seed selection: the same prompt + reroll count always picks
 *  the same seed, but rerolling (or a different prompt) picks a different
 *  one. Costs zero tokens — the bank is curated once, offline. */
function pickDesignSeed(prompt: string, reroll = 0): DesignSeed {
  const normalized = `${prompt.trim().toLowerCase()}::${reroll}`;
  const index = djb2Hash(normalized) % designSeeds.length;
  return designSeeds[index];
}

/** Detects prompts that already specify their own visual taste (explicit
 *  colors, fonts, or style words) so the seed injection can defer to the
 *  user instead of overriding them. */
function promptHasExplicitStyle(prompt: string): boolean {
  return /\b(#[0-9a-f]{3,6}|dark mode|light mode|minimalist|brutalist|retro|neon|pastel|corporate|colou?rs?:|font|typeface|style like|look like)\b/i.test(prompt);
}

function designSeedPromptLine(seed: DesignSeed, options?: { explicitStyle?: boolean; replacesPrevious?: boolean }): string {
  const lead = options?.explicitStyle
    ? "The user specified style preferences — those take priority; use the seed only to fill gaps."
    : "Design seed (follow it unless the user's request specifies its own style/colors — the user always wins):";
  const replaces = options?.replacesPrevious ? " This replaces the previous seed — use this one instead from here on." : "";
  return `${lead}${replaces} [${seed.name}] — palette ${seed.palette.join(", ")}, type ${seed.type.display}/${seed.type.body}, layout ${seed.layout}, motion ${seed.motion}, copy voice ${seed.voice}.`;
}

/** Short human-readable chat line for a chosen seed, kept under ~110 chars. */
function designSeedTimelineText(seed: DesignSeed): string {
  return `Design seed: "${seed.name}" — ${seed.type.display} over ${seed.type.body}, ${seed.palette[0]}/${seed.palette[1]}, ${seed.layout.split(",")[0]}.`;
}

/** Does a mid-run directive ask for a different design seed? Kept minimal —
 *  matches "reroll/new/different" near "seed/design/style/look". */
function directiveRequestsSeedReroll(text: string): boolean {
  return /\b(reroll|new|different)\b.*\b(seed|design|style|look)\b/i.test(text);
}

// --- Run cancellation (stop button) ---
// Scoped like the directive bus: projectPath or "global". Historically only
// checked at stage / repair / recovery boundaries (an in-flight provider call
// ran to completion first). Now backed by a live AbortController registry
// (below) so a cancel also kills any in-flight fetch immediately instead of
// waiting for the next boundary check.
const cancelledScopes = new Set<string>();

// The exact message every cancellation path throws — throwIfCancelled below,
// and the AbortError guard inside invokeProvider/callStageWithFallback — so
// every existing catch site (renderer included) treats them identically.
const CANCELLATION_MESSAGE = "Stopped by user.";

function cancellationError(): Error {
  return new Error(CANCELLATION_MESSAGE);
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message === CANCELLATION_MESSAGE;
}

/** True for a fetch aborted via AbortController#abort() — both the standard
 *  DOMException the platform throws and any polyfill that only sets `.name`. */
function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

// Live AbortControllers keyed by the same scope as cancelledScopes, so a
// cancel can reach into every in-flight provider fetch registered under that
// scope (chat-path invoke, build-pipeline stage calls, repair/recovery/critic
// calls — anywhere invokeProvider is given a scope) and abort it directly.
const liveAbortControllers = new Map<string, Set<AbortController>>();

function registerAbortController(scope: string): AbortController {
  const controller = new AbortController();
  let set = liveAbortControllers.get(scope);
  if (!set) {
    set = new Set();
    liveAbortControllers.set(scope, set);
  }
  set.add(controller);
  return controller;
}

function unregisterAbortController(scope: string, controller: AbortController): void {
  const set = liveAbortControllers.get(scope);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) liveAbortControllers.delete(scope);
}

function abortLiveCalls(scope: string): void {
  const set = liveAbortControllers.get(scope);
  if (!set || set.size === 0) return;
  for (const controller of set) {
    try {
      controller.abort();
    } catch {
      // Already settled/aborted — nothing to do.
    }
  }
  liveAbortControllers.delete(scope);
}

function requestSessionCancel(projectPath?: string): void {
  const scope = directiveScopeKey(projectPath);
  cancelledScopes.add(scope);
  // Real abort, not just a flag: kill every live fetch registered under this
  // scope right now, instead of waiting for the next stage/repair boundary.
  abortLiveCalls(scope);
}

function clearSessionCancel(projectPath?: string): void {
  cancelledScopes.delete(directiveScopeKey(projectPath));
}

function throwIfCancelled(projectPath?: string): void {
  const scope = directiveScopeKey(projectPath);
  if (cancelledScopes.has(scope)) {
    cancelledScopes.delete(scope);
    throw cancellationError();
  }
}

// --- Session directive bus (mid-run steering; docs/AGENTIC_ROADMAP.md §3) ---
const sessionDirectives = new Map<string, SessionDirective[]>();

function directiveScopeKey(projectPath?: string): string {
  return projectPath?.trim() || "global";
}

async function postSessionDirective(input: {
  projectPath?: string;
  conversationId?: string;
  text: string;
  kind?: SessionDirective["kind"];
  fromAgent?: string;
  toAgent?: string;
}): Promise<SessionDirective> {
  const text = input.text.trim();
  if (!text) throw new Error("A directive needs text.");
  const scopeKey = directiveScopeKey(input.projectPath);
  const directive: SessionDirective = {
    id: randomUUID(),
    scopeKey,
    fromConversationId: input.conversationId,
    createdAt: new Date().toISOString(),
    text,
    status: "pending",
    kind: input.kind,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent
  };
  sessionDirectives.set(scopeKey, [...(sessionDirectives.get(scopeKey) ?? []), directive]);
  await appendAudit("info", "session.directive", `Mid-run direction queued: ${text.slice(0, 120)}`, {
    scopeKey,
    conversationId: input.conversationId,
    kind: input.kind ?? "steer",
    toAgent: input.toAgent
  });
  return directive;
}

/** Convenience wrapper for a fan-out sub-agent step to address a directive at
 *  another named agent (or the manager). Thin layer over postSessionDirective
 *  that just fixes fromAgent/toAgent/kind in one call — no inter-agent traffic
 *  is generated on its own; a future fan-out agent step calls this explicitly
 *  (see the call-site comment in runFanoutPipeline's per-agent loop). */
async function postAgentDirective(input: {
  projectPath?: string;
  fromAgent: string;
  toAgent: string;
  text: string;
  kind: "handoff" | "question" | "review_request";
}): Promise<SessionDirective> {
  return postSessionDirective({
    projectPath: input.projectPath,
    text: input.text,
    kind: input.kind,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent
  });
}

function listSessionDirectives(projectPath?: string): SessionDirective[] {
  return sessionDirectives.get(directiveScopeKey(projectPath)) ?? [];
}

/** Pop pending directives for this project and mark them applied at the given
 *  stage. When `consumerAgent` is omitted, behavior is byte-identical to
 *  before agent-to-agent addressing existed: every pending directive is
 *  delivered and marked applied (this is also what happens when every pending
 *  directive has no `toAgent`, i.e. is a broadcast). When `consumerAgent` is
 *  supplied, a directive is only delivered to this call when its `toAgent` is
 *  absent (broadcast) or matches `consumerAgent`; directives addressed to a
 *  DIFFERENT agent are left pending untouched so their real target can still
 *  pick them up later. Only the directives actually delivered get marked
 *  applied — never touch the ones skipped over. */
function takePendingDirectives(projectPath: string | undefined, stageId: string, consumerAgent?: string): SessionDirective[] {
  const scopeKey = directiveScopeKey(projectPath);
  const all = sessionDirectives.get(scopeKey) ?? [];
  const deliverable = (directive: SessionDirective): boolean => {
    if (directive.status !== "pending") return false;
    if (!directive.toAgent) return true;
    return directive.toAgent === consumerAgent;
  };
  const pending = all.filter(deliverable);
  if (pending.length === 0) return [];
  const deliveredIds = new Set(pending.map((directive) => directive.id));
  sessionDirectives.set(
    scopeKey,
    all.map((directive) => (deliveredIds.has(directive.id) ? { ...directive, status: "applied" as const, appliedAtStage: stageId } : directive))
  );
  return pending.map((directive) => ({ ...directive, status: "applied" as const, appliedAtStage: stageId }));
}

async function runOrchestratedStages(
  prompt: string,
  stream?: SessionStreamController,
  override?: SessionModelOverride,
  projectPath?: string,
  metisFile?: { content: string; chars: number } | null,
  permissionMode: PermissionMode = "auto",
  conversationContext?: string | null,
  images?: ProviderImageInput[]
): Promise<{ stages: OrchestrationStage[]; designSeed: DesignSeed }> {
  const metisBlock = metisFilePromptBlock(metisFile ?? null);
  const singleFile = wantsSingleFileFrontend(prompt);
  // Same scope key the Stop button cancels by (directiveScopeKey(projectPath))
  // — every stage/critic call below registers its AbortController under this
  // key so a cancel reaches every live call this run has in flight.
  const scope = directiveScopeKey(projectPath);
  const { stages, source: stageSource } = await resolveAgenticStages(prompt, override);
  const results: OrchestrationStage[] = [];
  const steeringLog: string[] = [];
  let plan = "";
  let frontend = "";

  // docs/FABLE_PLANS.md section 25 — name the pipeline source up front so the
  // user can tell at a glance whether their graph is actually driving the
  // build or the run fell back to the hardcoded default pipeline.
  emitTimeline(
    stream,
    timelineText(
      stageSource === "graph"
        ? `Running your orchestration graph pipeline (${stages.length} stage${stages.length === 1 ? "" : "s"}).`
        : "Running the default build pipeline."
    )
  );

  // Design seed: picked once per run so every stage sees the same taste.
  // Rerollable mid-run via a steering directive (see below).
  let rerollCount = 0;
  let seed = pickDesignSeed(prompt, rerollCount);
  let seedReplacesPrevious = false;
  const explicitStyle = promptHasExplicitStyle(prompt);
  emitTimeline(stream, timelineText(designSeedTimelineText(seed)));

  // Set by the frontend stage below when retrieveBestStyleCard finds a card
  // carrying a downscaled reference image (task L9, docs/DRILL_PLAN.md Phase 2)
  // — read back further down when assembling stageImages for that same stage.
  let styleCardImage: ProviderImageInput | undefined;

  for (const stage of stages) {
    throwIfCancelled(projectPath);
    let stagePrompt: string;
    if (stage.templateRole === "plan") {
      stagePrompt = `You are the PLANNING model in a build pipeline. The user wants:\n${prompt}\n\nWrite a short, concrete build plan: the pages/components, the data, and the interactivity. Be tight — no code yet, just the plan.\n\nNever ask the user for a brief, requirements, or say the project is empty. If details are missing, invent tasteful, specific choices yourself (name, copy, palette, content) and state them briefly — you are the creative lead. Do not end with a question asking permission to proceed; proceed.`;
      if (conversationContext) stagePrompt = `Recent conversation (for continuity — the newest user request is the task):\n${conversationContext}\n\n${stagePrompt}`;
    } else if (stage.templateRole === "frontend") {
      stagePrompt = `You are the FRONT-END model. Build the UI for this plan.\n\nPlan:\n${plan}\n\nReturn COMPLETE files, not snippets. Before each fenced code block, put the file path in backticks on its own line (e.g. \`index.html\` or \`public/index.html\`). Keep it clean and minimal — one short sentence of intro, then the files.\n\nAvoid the generic AI look — do not default to purple/violet gradients; choose a distinctive, coherent palette and typography that fit the subject.`;
      // Gallery visual RAG retrieval (docs/FABLE_PLANS.md section 4): the
      // user's own gallery outranks the canned design seed, but never the
      // user's explicit request. Fails soft — no cards/no match changes nothing.
      const styleCard = await retrieveBestStyleCard(plan, prompt);
      if (styleCard) {
        const captionText = styleCard.caption || "(no caption — palette-only reference)";
        stagePrompt += `\n\nStyle reference from the user's gallery (this outranks the design seed; the user's explicit request outranks everything): ${captionText}. Mood: ${styleCard.moodTags.join(", ") || "none"}. Palette: ${styleCard.palette.join(", ") || "none"}.`;
        const trimmedCaption = captionText.length > 80 ? `${captionText.slice(0, 77)}...` : captionText;
        let hasImage = false;
        // Hand the actual reference image (not just its caption) to vision-capable
        // providers, subject to the shared attachment cap — see stageImages assembly
        // below, which gives user attachments priority (task L9).
        try {
          if (styleCard.imageBase64 && styleCard.imageMime) {
            styleCardImage = { data: styleCard.imageBase64, mimeType: styleCard.imageMime };
            hasImage = true;
          }
        } catch {
          styleCardImage = undefined;
        }
        stagePrompt += hasImage
          ? " A reference image from the gallery is attached below — use it to guide look and feel alongside this description."
          : "";
        emitTimeline(stream, timelineText(`Style reference: "${trimmedCaption}"${hasImage ? " (image attached)" : ""}`));
      }
    } else {
      stagePrompt = `You are the FUNCTIONALITY model. Make the site actually work end to end.\n\nPlan:\n${plan}\n\nFront end so far:\n${frontend}\n\nReturn COMPLETE files (full contents, not diffs) for everything needed to run it — backend (e.g. \`server.js\`, \`package.json\`) and any updated front-end files. Before each fenced code block, put the file path in backticks on its own line. One short sentence of intro, then the files.`;
    }
    if (metisBlock) stagePrompt = `${metisBlock}\n${stagePrompt}`;
    if (stage.templateRole === "plan" && singleFile) {
      stagePrompt += "\n\nImportant constraint: this must remain one static index.html file. Do not plan a server, package.json, external local CSS file, or extra JS file.";
    }
    if (stage.templateRole === "frontend" && singleFile) {
      stagePrompt = `You are the FRONT-END model. Build the UI for this plan.\n\nPlan:\n${plan}\n\nReturn EXACTLY ONE complete file: \`index.html\`. Put the file path \`index.html\` on its own line before the fenced code block. All CSS must be inside a <style> tag. All JavaScript must be inside a <script> tag. Do not reference local files such as styles.css, script.js, package.json, server.js, images, or assets. No backend. One short sentence of intro, then the one file.\n\nAvoid the generic AI look — do not default to purple/violet gradients; choose a distinctive, coherent palette and typography that fit the subject.`;
    }
    // Reference-image attachments: only the front-end stage gets images (never
    // plan/functionality) — see docs comment on runOrchestratedStages' images
    // param. No-op when there are no attachments.
    let stageImages = stage.templateRole === "frontend" && images && images.length > 0 ? images : undefined;
    if (stageImages) {
      stagePrompt += attachmentNoteFor(stageImages.length);
    }
    // Fold the gallery style-reference image into the same images array the
    // front-end stage sends to the provider (task L9, docs/DRILL_PLAN.md Phase 2).
    // User attachments always take priority over the style reference; the style
    // image is only added if there's still room under MAX_ATTACHMENT_IMAGES, and
    // is silently dropped otherwise rather than bumping something the user attached.
    if (stage.templateRole === "frontend" && styleCardImage) {
      const existingCount = stageImages?.length ?? 0;
      if (existingCount < MAX_ATTACHMENT_IMAGES) {
        stageImages = stageImages ? [...stageImages, styleCardImage] : [styleCardImage];
      }
    }
    // Mid-run steering: absorb directives posted while earlier stages were running.
    const newDirectives = takePendingDirectives(projectPath, stage.id);
    for (const directive of newDirectives) {
      emitTimeline(stream, timelineText(`Picked up direction: “${directive.text}”`));
      if (directiveRequestsSeedReroll(directive.text)) {
        rerollCount++;
        seed = pickDesignSeed(prompt, rerollCount);
        seedReplacesPrevious = true;
        emitTimeline(stream, timelineText(designSeedTimelineText(seed)));
      } else {
        steeringLog.push(directive.text);
      }
    }
    if (steeringLog.length > 0) {
      stagePrompt += `\n\nMid-run directions from the user (they arrived while the build was running and OVERRIDE the original request wherever they conflict):\n${steeringLog.map((text) => `- ${text}`).join("\n")}`;
    }
    // Design seed injection: build stages only (plan + frontend), never the
    // functionality stage — the seed is a visual/voice constraint.
    if (stage.templateRole === "plan" || stage.templateRole === "frontend") {
      stagePrompt += `\n\n${designSeedPromptLine(seed, { explicitStyle, replacesPrevious: seedReplacesPrevious })}`;
    }
    // AskUserQuestion (docs/FABLE_PLANS.md section 24; multi-question form
    // docs/DRILL_PLAN.md B2.3a): models MAY emit ONE tag per stage for a
    // genuinely blocking decision — never for "what would you like to
    // build", since the model remains the creative lead.
    stagePrompt += `\n\nIf, and only if, a genuinely blocking decision needs the user's input (not a creative choice you can make yourself), you may emit ONE tag anywhere in your output, either a single question: <ask_user>{"question":"...","options":["a","b"]}</ask_user> or, if you have up to 4 related blocking questions, a batch in one tag: <ask_user>{"questions":[{"question":"...","options":["a","b"],"allowCustom":true}]}</ask_user> (max 4 questions; "allowCustom" just hints that a free-text answer is welcome). Otherwise never emit this tag — decide tastefully yourself and proceed.`;
    if (stage.templateRole === "plan") {
      emitTimeline(stream, timelineText("Planning the build and checking the constraints."));
    } else if (stage.templateRole === "frontend") {
      emitTimeline(stream, timelineText("Calling the front-end route now."));
    } else {
      emitTimeline(stream, timelineText("Checking whether the build needs functionality or support files."));
    }
    const stageCallContext: StageCallContext = { stream, stageId: stage.id, stageLabel: stage.label, scope };
    let attempt = await callStageWithFallback(stage.chain, stagePrompt, stage.gatewayPreference, stageCallContext, stageImages);
    // Scan for an AskUserQuestion tag; if present, pause for an answer (or up
    // to 4 answers for the multi-question form), strip the tag, append the
    // Q&A to the stage prompt, and re-run once.
    const askedQuestion = extractAskUserTag(attempt.output);
    if (askedQuestion) {
      const { answer, answers, timedOut } = await promptUserQuestion(
        stream,
        askedQuestion.question,
        askedQuestion.options,
        askedQuestion.questions
      );
      if (timedOut) {
        emitTimeline(stream, timelineText(`No answer in time — I picked "${answer}" and kept going.`));
      }
      const qaText =
        askedQuestion.questions && askedQuestion.questions.length > 0
          ? askedQuestion.questions
              .map((q, i) => `You previously asked: "${q.text}"\nUser answered: ${answers[i] ?? answer}`)
              .join("\n\n")
          : `You previously asked: "${askedQuestion.question}"\nUser answered: ${answer}`;
      const continuationPrompt = `${stagePrompt}\n\n${qaText}\n\nContinue with the full stage output now (do not ask again).`;
      attempt = await callStageWithFallback(stage.chain, continuationPrompt, stage.gatewayPreference, stageCallContext, stageImages);
    }
    await appendAudit(attempt.failed ? "error" : "info", "session.stage", `Stage ${stage.label} via ${stageModelLabel(attempt.ref)}.`, {
      stage: stage.id,
      provider: attempt.ref.provider,
      model: attempt.ref.model,
      failed: attempt.failed
    });
    // Think-tag content must never leak into extracted files, later stage
    // prompts, or chat markdown — strip it out and keep it on the stage
    // separately so the renderer can surface it later.
    const rawOutput = attempt.output;
    const stageThoughts = splitThinkTaggedOutput(rawOutput).thoughts;
    let cleanOutput = stripAskUserTags(stripThinkBlocks(rawOutput));
    // "Is this done?" critic loop (docs/FABLE_PLANS.md §22): only worth
    // running when the stage actually produced something to judge.
    let criticPasses = 0;
    if (!attempt.failed && cleanOutput.trim()) {
      const criticResult = await runCriticLoop({
        stageLabel: stage.label,
        stagePrompt,
        chain: stage.chain,
        ref: attempt.ref,
        output: cleanOutput,
        stream,
        gatewayPreference: stage.gatewayPreference,
        stageId: stage.id,
        images: stageImages,
        scope
      });
      cleanOutput = criticResult.output;
      criticPasses = criticResult.criticPasses;
    }
    const completedStage: OrchestrationStage = {
      id: stage.id,
      label: stage.label,
      provider: attempt.ref.provider,
      model: attempt.ref.model,
      output: cleanOutput,
      thoughts: stageThoughts || undefined,
      fallbackNotes: attempt.notes,
      failed: attempt.failed,
      criticPasses: criticPasses > 0 ? criticPasses : undefined
    };
    results.push(completedStage);
    emitStream(stream, { kind: "stage", stage: completedStage });
    emitStream(stream, {
      kind: "step",
      step: {
        id: completedStage.id,
        label: `${completedStage.label} - ${providerInfo[completedStage.provider].label}`,
        detail: completedStage.failed ? "All models failed." : `Handled by ${stageModelLabel({ provider: completedStage.provider, model: completedStage.model })}.`,
        status: completedStage.failed ? "error" : "complete",
        completedAt: new Date().toISOString()
      }
    });
    emitTimeline(stream, { id: randomUUID(), kind: "stage", stageId: completedStage.id });
    if (stage.templateRole === "plan") plan = cleanOutput;
    if (stage.templateRole === "frontend") frontend = cleanOutput;
    // Plan mode (docs/FABLE_PLANS.md section 24): read-only — run only the
    // plan stage, no writes/commands, then stop before front end/functional.
    if (stage.templateRole === "plan" && permissionMode === "plan") {
      emitTimeline(stream, timelineText("Plan mode — nothing was written. Switch to Auto and rerun to build it."));
      break;
    }
  }
  return { stages: results, designSeed: seed };
}

// --- Self-healing verify -> repair loop (docs/AGENTIC_ROADMAP.md §4) ---
const REPAIR_PASS_LIMIT = 2;

function repairEvidence(project: ProjectToolResult): string {
  const failedCommands = (project.verificationCommands ?? []).filter((operation) => operation.status !== "complete");
  return [
    project.verificationDetail,
    ...(project.verificationConsoleErrors ?? []).map((line) => `Console error: ${line}`),
    ...failedCommands.map(
      (operation) =>
        `${operation.label}${operation.exitCode !== undefined ? ` (exit ${operation.exitCode})` : ""}${operation.stderr ? `:\n${operation.stderr.slice(0, 1200)}` : ""}`
    )
  ]
    .filter(Boolean)
    .join("\n");
}

function repairChainFor(override?: SessionModelOverride): StageModelRef[] {
  const deepseek: StageModelRef = { provider: "deepseek", model: "deepseek-chat" };
  const claude: StageModelRef = { provider: "anthropic", model: providerInfo.anthropic.defaultModel ?? "claude-sonnet-4-6" };
  const base: StageModelRef[] = [deepseek, claude, localStageRef()];
  if (!override) return base;
  const pinned = overrideStageRef(override);
  return [pinned, ...base.filter((ref) => ref.provider !== pinned.provider || ref.model !== pinned.model)];
}

// --- Manager chat (docs/FABLE_PLANS.md — Manager tab round 1: real chat with
// context on the owner's projects and to-do board) ---

/** Minimal shape read back out of the `todoBoard` store key — deliberately
 *  loose (not the renderer's full TodoBoard type) since main.ts only ever
 *  summarizes counts here and must not throw on a shape it doesn't fully own. */
type ManagerTodoCard = { done?: boolean; assignee?: { kind?: string } };
type ManagerTodoColumn = { id?: string; title?: string; cards?: ManagerTodoCard[] };
type ManagerTodoBoard = { columns?: ManagerTodoColumn[] };

/** Shape of the renderer-set `managerModel` app-store key: an explicit model
 *  to place at the head of the Manager chat chain, or null for the default
 *  chain. Kept loose (not trusted) since it's read back out of JSON on disk. */
type ManagerModelOverride = { provider?: string; model?: string } | null;

/** Resolves the `managerModel` app-store override into a StageModelRef, or
 *  null if unset/invalid. Guarded end to end — a missing/malformed store
 *  value (or an unrecognized provider key) never throws; it just means "no
 *  override", and managerChatChain falls back to its default chain. */
async function resolveManagerModelOverride(): Promise<StageModelRef | null> {
  try {
    const override = await readStoreValue<ManagerModelOverride>("managerModel", null);
    if (!override || typeof override.model !== "string" || !override.model.trim()) return null;
    const provider = override.provider as ProviderKey | undefined;
    if (!provider || !(provider in providerInfo)) return null;
    return { provider, model: override.model.trim() };
  } catch {
    return null;
  }
}

/** Builds the Manager chat model chain: Claude -> DeepSeek -> local Ollama by
 *  default so it works whichever keys are set, with the owner's `managerModel`
 *  override (if any) placed at the head and de-duplicated out of the default
 *  entries so it isn't tried twice. */
async function managerChatChain(): Promise<StageModelRef[]> {
  const claude: StageModelRef = { provider: "anthropic", model: providerInfo.anthropic.defaultModel ?? "claude-sonnet-4-6" };
  const deepseek: StageModelRef = { provider: "deepseek", model: "deepseek-chat" };
  const base: StageModelRef[] = [claude, deepseek, localStageRef()];
  const override = await resolveManagerModelOverride();
  if (!override) return base;
  return [override, ...base.filter((ref) => ref.provider !== override.provider || ref.model !== override.model)];
}

/** Builds the live-context block injected into the Manager system prompt:
 *  known projects (the selected workspace + any added resources) and an
 *  outstanding-work summary from the shared `todoBoard` store key (same
 *  board the To-Do view and the suggestion-lane Manager read). There is no
 *  goals store yet, so that slot is left explicitly empty rather than
 *  inventing content the owner never gave us. */
async function buildManagerContext(): Promise<string> {
  const [workspace, resources, board] = await Promise.all([
    readProjectWorkspace(),
    listProjectResources(),
    readStoreValue<ManagerTodoBoard>("todoBoard", { columns: [] })
  ]);
  const projectNames = Array.from(
    new Set([...(workspace ? [workspace.name] : []), ...resources.map((resource) => resource.name)])
  );

  const columns = board.columns ?? [];
  const columnSummary = columns
    .map((column) => {
      const cards = column.cards ?? [];
      const open = cards.filter((card) => !card.done);
      return `${column.title ?? "Untitled"}: ${open.length} open of ${cards.length}`;
    })
    .join("; ");

  const assigneeCounts = new Map<string, number>();
  for (const column of columns) {
    for (const card of column.cards ?? []) {
      if (card.done) continue;
      const kind = card.assignee?.kind ?? "unassigned";
      assigneeCounts.set(kind, (assigneeCounts.get(kind) ?? 0) + 1);
    }
  }
  const assigneeSummary = Array.from(assigneeCounts.entries())
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(", ");

  return [
    `Known projects: ${projectNames.length ? projectNames.join(", ") : "none set up yet — no project workspace or resources are configured."}`,
    `To-do board by column — ${columnSummary || "no columns on the board yet."}`,
    `Open work by owner — ${assigneeSummary || "nothing open right now."}`,
    `Goals: no goals store exists yet, so nothing is injected here — don't invent goals; ask the owner if it matters.`
  ].join("\n");
}

function managerSystemPrompt(context: string): string {
  return [
    `You are Metis Manager, a concise, action-oriented assistant embedded in the Manager tab of Metis Orchestrator.`,
    `You help the owner run his projects: you know what projects exist and what's on his to-do board, and you help him plan, prioritize, and think through his work.`,
    `Live context:`,
    context,
    `You can advise, help plan, and reference specific projects or todos by name when it's useful.`,
    `You may also PROPOSE actions for the owner to approve — you never execute anything yourself, the owner reviews and approves each one in the UI. Propose actions ONLY when the owner clearly wants something done (not for general advice or discussion). If no action is called for, do not include the block at all.`,
    `To propose actions, end your reply with a fenced block, exactly this shape, after your normal conversational reply:`,
    '```metis-actions\n[ { "kind": "add_todo", "title": "...", "reason": "..." } ]\n```',
    `Rules for the block: it must be the LAST thing in your reply; it must contain a JSON array (even if it has one item); do not add commentary inside or after it. Keep your actual conversational answer above the block, as normal prose.`,
    `Available action kinds and their fields:`,
    `- "run_in_project": { "prompt": string, "projectPath"?: string, "reason"?: string } — projectPath is optional and defaults to the current project workspace.`,
    `- "add_todo": { "title": string, "assignee"?: "manager" | "fable", "reason"?: string } — adds a card to the to-do board.`,
    `- "open_view": { "view": string, "reason"?: string } — view is one of: orchestration, marketplace, gallery, benchmark, todo, routines, graph, session, manager, settings, pulse.`,
    `Every action should carry a short "reason" explaining why you're proposing it. Propose at most a few actions per reply — do not flood the owner with proposals.`,
    `Be concise and direct. Do not pad with filler, do not ask permission before giving your answer, and do not narrate your own reasoning process — just help.`
  ].join("\n\n");
}

const MANAGER_ACTION_KINDS: ManagerActionKind[] = ["run_in_project", "add_todo", "open_view"];
const MANAGER_ACTION_VIEWS = new Set([
  "orchestration", "marketplace", "gallery", "benchmark", "todo", "routines", "graph", "session", "manager", "settings", "pulse"
]);

/** Validates one candidate parsed out of a Manager reply's `metis-actions`
 *  block: known kind, required fields present and the right type. Returns
 *  null (never throws) for anything malformed so the caller can just drop it. */
function validateManagerAction(candidate: unknown): ManagerAction | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !MANAGER_ACTION_KINDS.includes(kind as ManagerActionKind)) return null;

  const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const isOptionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";

  const reason = isOptionalString(raw.reason) ? raw.reason : undefined;

  if (kind === "run_in_project") {
    if (!isNonEmptyString(raw.prompt) || !isOptionalString(raw.projectPath)) return null;
    return { kind, prompt: raw.prompt, projectPath: raw.projectPath, reason };
  }
  if (kind === "add_todo") {
    if (!isNonEmptyString(raw.title)) return null;
    if (raw.assignee !== undefined && raw.assignee !== "manager" && raw.assignee !== "fable") return null;
    return { kind, title: raw.title, assignee: raw.assignee as string | undefined, reason };
  }
  if (kind === "open_view") {
    if (!isNonEmptyString(raw.view) || !MANAGER_ACTION_VIEWS.has(raw.view)) return null;
    return { kind, view: raw.view, reason };
  }
  return null;
}

/** Extracts a trailing ```metis-actions fenced JSON block from a Manager
 *  reply (if present), validates each proposed action, and returns the reply
 *  text with the block stripped out. Never throws: a missing or malformed
 *  block just yields the reply untouched and `actions: undefined`. */
function extractManagerActions(reply: string): { reply: string; actions?: ManagerAction[] } {
  try {
    const match = reply.match(/```metis-actions\s*([\s\S]*?)```\s*$/);
    if (!match) return { reply };
    const jsonText = match[1].trim();
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return { reply };
    const actions = parsed.map(validateManagerAction).filter((action): action is ManagerAction => action !== null);
    const stripped = reply.slice(0, match.index).trimEnd();
    return { reply: stripped, actions: actions.length ? actions : undefined };
  } catch {
    return { reply };
  }
}

/** Non-streaming Manager chat turn: builds live context, calls the model chain
 *  (Claude -> DeepSeek -> local Ollama, so it works whichever keys are set),
 *  and never throws — any failure comes back as `{ reply: "", error }` so the
 *  renderer can show a plain message instead of crashing. */
async function runManagerChat(history: ManagerChatMessage[]): Promise<ManagerChatResult> {
  try {
    const context = await buildManagerContext();
    const system = managerSystemPrompt(context);
    const transcript = (history ?? [])
      .slice(-20)
      .map((turn) => `${turn.role === "user" ? "Owner" : "Manager"}: ${turn.content}`)
      .join("\n\n");
    const prompt = [system, "", "Conversation so far:", transcript || "(no prior turns)", "", "Manager:"].join("\n");
    const result = await callStageWithFallback(await managerChatChain(), prompt);
    if (result.failed || !result.output.trim()) {
      const detail = result.notes.join(" ") || "No model in the chain produced a reply.";
      await appendAudit("warning", "manager.chat", "Manager chat turn failed.", { notes: result.notes });
      return { reply: "", error: detail };
    }
    await appendAudit("info", "manager.chat", "Manager replied to a chat turn.", {
      provider: result.ref.provider,
      model: result.ref.model
    });
    const { reply, actions } = extractManagerActions(result.output);
    if (actions?.length) {
      await appendAudit("info", "manager.action", "Manager proposed actions.", {
        kinds: actions.map((action) => action.kind)
      });
    }
    return { reply, actions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reply: "", error: message };
  }
}

/** Full shape written back to the `todoBoard` store key for add_todo — matches
 *  the renderer's TodoCard/TodoColumn/TodoBoard shape (src/renderer/ui/App.tsx)
 *  but kept local since main.ts must not depend on renderer types. */
type ManagerWritableCard = { id: string; title: string; priority: "high" | "medium" | "idea" | "none"; done: boolean; assignee?: { kind: string } };
type ManagerWritableBoard = { columns: { id: string; title: string; cards: ManagerWritableCard[] }[] };

/** Executes exactly one Manager-proposed action, AFTER the owner has approved
 *  it in the renderer. Re-validates the action from scratch (never trusts the
 *  renderer's copy) since this is the actual side-effecting boundary — the
 *  parse step in runManagerChat only decides what to *show* the owner. */
async function executeManagerAction(rawAction: ManagerAction): Promise<ManagerActionResult> {
  const action = validateManagerAction(rawAction);
  if (!action) {
    return { ok: false, error: "Action failed server-side validation." };
  }

  try {
    if (action.kind === "open_view") {
      await appendAudit("info", "manager.action", "Executed open_view action.", { view: action.view });
      return { ok: true, view: action.view };
    }

    if (action.kind === "add_todo") {
      const board = await readStoreValue<ManagerWritableBoard>("todoBoard", { columns: [] });
      const columns = board.columns ?? [];
      let target = columns.find((column) => column.id === "todo") ?? columns[0];
      if (!target) {
        target = { id: "backlog", title: "Backlog", cards: [] };
        columns.push(target);
      }
      const card: ManagerWritableCard = {
        id: randomUUID(),
        title: action.title ?? "Untitled",
        priority: "none",
        done: false,
        assignee: action.assignee ? { kind: action.assignee } : undefined
      };
      target.cards = [...(target.cards ?? []), card];
      await writeStoreValue("todoBoard", { columns });
      await appendAudit("info", "manager.action", "Executed add_todo action.", { title: card.title, assignee: action.assignee });
      return { ok: true };
    }

    if (action.kind === "run_in_project") {
      // Reuses runSession as-is (same path metis-session:run drives) so this
      // gets the exact same permission gating, routing, and audit trail as a
      // run the owner started by hand — nothing here bypasses that.
      //
      // BUGFIX (DRILL_PLAN B2.7): this app only ever supports ONE attached +
      // granted project workspace at a time (readProjectWorkspace reads a
      // single global store key — see selectProjectWorkspace/clearProjectWorkspace).
      // The Manager model proposes `action.projectPath` itself, and that value
      // is not grounded in anything the user actually attached — it can be a
      // slightly-off or hallucinated path (wrong casing/slashes, a subfolder,
      // a stale guess). The old `action.projectPath ?? workspace?.path` let
      // ANY non-empty model-proposed path win over the real, permission-
      // granted workspace. Downstream, resolveWritableProjectWorkspace()
      // rejects a projectPath that doesn't exactly match the attached
      // workspace (returns null rather than falling back to it), so the
      // build pipeline's writeProjectFiles() silently redirected every
      // generated/edited file to the dataPath("generated-projects", ...)
      // scratch folder under the app's data directory (same root that also
      // holds conversations.json / the knowledge cache) instead of the
      // attached workspace folder. Since there is no legitimate scenario
      // where a model-guessed path should out-rank the one real attached
      // workspace, always prefer the attached workspace when one exists;
      // only fall back to the model's proposed path when nothing is
      // attached at all (unchanged behavior for the "no workspace" case).
      const workspace = await readProjectWorkspace();
      const projectPath = workspace?.path ?? action.projectPath;
      const run = await runSession({
        prompt: action.prompt ?? "",
        projectPath,
        permissionMode: "ask"
      });
      await appendAudit("info", "manager.action", "Executed run_in_project action.", { projectPath, conversationId: run.conversationId });
      return { ok: true, conversationId: run.conversationId };
    }

    return { ok: false, error: "Unsupported action kind." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendAudit("warning", "manager.action", "Manager action execution failed.", { kind: action.kind, error: message });
    return { ok: false, error: message };
  }
}

/** When verification fails after a build, feed the failures back into a repair
 *  model, rewrite the corrected files, and re-verify — up to REPAIR_PASS_LIMIT. */
async function runRepairPasses(args: {
  prompt: string;
  files: GeneratedFile[];
  projectResult: ProjectToolResult;
  writable: ProjectWorkspace | null;
  singleFile: boolean;
  override?: SessionModelOverride;
  stages: OrchestrationStage[];
  stream?: SessionStreamController;
  metisFile?: { content: string; chars: number } | null;
  scope?: string;
}): Promise<{ projectResult: ProjectToolResult; files: GeneratedFile[]; repairCount: number }> {
  let projectResult = args.projectResult;
  let files = args.files;
  let repairCount = 0;
  while (!projectResult.verified && repairCount < REPAIR_PASS_LIMIT) {
    repairCount++;
    emitTimeline(args.stream, timelineText(`Verification flagged issues — running repair pass ${repairCount} of ${REPAIR_PASS_LIMIT}.`));
    const fileDump = files
      .filter((file) => file.path !== "metis-brief.md")
      .map((file) => `\`${file.path}\`\n\`\`\`\n${file.content.slice(0, 6000)}\n\`\`\``)
      .join("\n\n");
    const repairPrompt = `${metisFilePromptBlock(args.metisFile ?? null)}You are the REPAIR model in a build pipeline. The project below was written to disk, but verification failed.\n\nOriginal request:\n${args.prompt}\n\nVerification failures:\n${repairEvidence(projectResult)}\n\nCurrent project files:\n${fileDump}\n\nFix the failures. Return COMPLETE corrected files (full contents, not diffs) for every file you change — and only the files you change. Before each fenced code block, put the file path in backticks on its own line. One short sentence about what was wrong, then the files.`;
    const repairStageId = `repair-${repairCount}`;
    const attempt = await callStageWithFallback(repairChainFor(args.override), repairPrompt, undefined, {
      stream: args.stream,
      stageId: repairStageId,
      stageLabel: `Repair pass ${repairCount}`,
      scope: args.scope
    });
    const repairThoughts = splitThinkTaggedOutput(attempt.output).thoughts;
    const repairCleanOutput = stripThinkBlocks(attempt.output);
    const repairStage: OrchestrationStage = {
      id: `repair-${repairCount}`,
      label: `Repair pass ${repairCount}`,
      provider: attempt.ref.provider,
      model: attempt.ref.model,
      output: repairCleanOutput,
      thoughts: repairThoughts || undefined,
      fallbackNotes: attempt.notes,
      failed: attempt.failed
    };
    args.stages.push(repairStage);
    emitStream(args.stream, { kind: "stage", stage: repairStage });
    emitStream(args.stream, {
      kind: "step",
      step: {
        id: repairStage.id,
        label: `Repair pass ${repairCount} - ${providerInfo[repairStage.provider].label}`,
        detail: repairStage.failed ? "All models failed." : `Handled by ${stageModelLabel({ provider: repairStage.provider, model: repairStage.model })}.`,
        status: repairStage.failed ? "error" : "complete",
        completedAt: new Date().toISOString()
      }
    });
    emitTimeline(args.stream, { id: randomUUID(), kind: "stage", stageId: repairStage.id });
    await appendAudit(attempt.failed ? "error" : "info", "session.repair", `Repair pass ${repairCount} via ${stageModelLabel(attempt.ref)}.`, {
      pass: repairCount,
      provider: attempt.ref.provider,
      model: attempt.ref.model,
      failed: attempt.failed
    });
    if (attempt.failed || !repairCleanOutput.trim()) break;
    const fixed = extractGeneratedFilesFromText(repairCleanOutput);
    if (fixed.length === 0) {
      emitTimeline(args.stream, timelineText("The repair pass returned no complete files, so I kept the previous write."));
      break;
    }
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    for (const file of fixed) byPath.set(file.path, file.content);
    files = Array.from(byPath.entries()).map(([path, content]) => ({ path, content }));
    emitTimeline(args.stream, timelineText(`Rewriting ${fixed.length} repaired file${fixed.length === 1 ? "" : "s"} and re-verifying.`));
    projectResult = await writeProjectFiles(files, args.writable, { singleFile: args.singleFile });
  }
  if (repairCount > 0) {
    emitTimeline(
      args.stream,
      timelineText(projectResult.verified ? "Verification passes after the repair." : "Still failing after the repair passes — leaving the full trace for review.")
    );
  }
  return { projectResult, files, repairCount };
}

// --- Extraction recovery (never concede on 0 extracted files without a fight) ---
const EXTRACTION_RECOVERY_LIMIT = 2;

/** When the build stages produced no complete extractable files, ask the
 *  build model again — explicitly — to output complete files instead of a
 *  description. Runs up to EXTRACTION_RECOVERY_LIMIT attempts before the
 *  caller falls back to the honest "nothing was written" concede path. */
async function runExtractionRecovery(args: {
  prompt: string;
  stages: OrchestrationStage[];
  override?: SessionModelOverride;
  stream?: SessionStreamController;
  metisFile?: { content: string; chars: number } | null;
  scope?: string;
}): Promise<GeneratedFile[]> {
  // Graph-driven stages (docs/FABLE_PLANS.md section 25) keep the graph
  // node's own id, not "plan"/"frontend" — fall back to position (stage 0 is
  // always the plan-role stage, stage 1 the frontend-role stage) when the
  // named lookup misses, so recovery still has real context either way.
  const planOutput = (args.stages.find((stage) => stage.id === "plan") ?? args.stages[0])?.output ?? "";
  const frontendOutput = (args.stages.find((stage) => stage.id === "frontend") ?? args.stages[1])?.output ?? "";
  // Reuse the frontend-style fallback chain, respecting a threaded-through
  // model override the same way defaultAgenticStages does for every stage.
  const frontendStage = defaultAgenticStages(args.prompt, args.override).find((stage) => stage.id === "frontend");
  const chain = frontendStage?.chain ?? (args.override ? [overrideStageRef(args.override), localStageRef()] : [localStageRef()]);

  for (let attemptNumber = 1; attemptNumber <= EXTRACTION_RECOVERY_LIMIT; attemptNumber++) {
    emitTimeline(
      args.stream,
      timelineText(`The stages didn't include complete files — asking the build model to write them out properly (attempt ${attemptNumber} of ${EXTRACTION_RECOVERY_LIMIT}).`)
    );
    const recoveryPrompt = `${metisFilePromptBlock(args.metisFile ?? null)}Your previous output described the project but did not include complete writable files. Output ALL project files NOW, complete file contents (not diffs, not descriptions). Before each fenced code block put the file path in backticks on its own line (e.g. \`index.html\`). Plan and prior output follow:\n${planOutput}\n${frontendOutput.slice(0, 8000)}`;
    const recoveryStageId = `extract-recovery-${attemptNumber}`;
    const recoveryStageLabel = `File recovery ${attemptNumber}`;
    const attempt = await callStageWithFallback(chain, recoveryPrompt, undefined, {
      stream: args.stream,
      stageId: recoveryStageId,
      stageLabel: recoveryStageLabel,
      scope: args.scope
    });
    const thoughts = splitThinkTaggedOutput(attempt.output).thoughts;
    let cleanOutput = stripThinkBlocks(attempt.output);
    // One cheap critique pass here too (docs/FABLE_PLANS.md §22) — skipped
    // entirely if the critic is unreachable/unparseable or self-verify is off.
    let criticPasses = 0;
    if (!attempt.failed && cleanOutput.trim() && (await shouldSelfVerifyStage(attempt.ref))) {
      const verdict = await critiqueStageOutput(`File recovery ${attemptNumber}`, recoveryPrompt, cleanOutput, args.scope);
      if (verdict && !verdict.done) {
        criticPasses = 1;
        const firstMissing = (verdict.missing[0] ?? "the rest of the files").trim();
        emitTimeline(args.stream, timelineText(`Self-check: still missing ${firstMissing.length > 100 ? `${firstMissing.slice(0, 97)}...` : firstMissing} — continuing.`));
        const missingList = verdict.missing.length > 0 ? verdict.missing.map((item) => `- ${item}`).join("\n") : "- (no specifics given, but the task is not finished)";
        const continuationPrompt = `${recoveryPrompt}\n\nYour previous output was incomplete. You MUST complete: \n${missingList}\n\nContinue and return the COMPLETE result (full files, not diffs).\n\nYour previous output:\n${cleanOutput.slice(0, 8000)}`;
        const retryAttempt = await callStageWithFallback(chain, continuationPrompt, undefined, {
          stream: args.stream,
          stageId: recoveryStageId,
          stageLabel: recoveryStageLabel,
          scope: args.scope
        });
        if (!retryAttempt.failed && retryAttempt.output.trim()) {
          cleanOutput = stripThinkBlocks(retryAttempt.output);
        }
      }
    }
    const recoveryStage: OrchestrationStage = {
      id: `extract-recovery-${attemptNumber}`,
      label: `File recovery ${attemptNumber}`,
      provider: attempt.ref.provider,
      model: attempt.ref.model,
      output: cleanOutput,
      thoughts: thoughts || undefined,
      fallbackNotes: attempt.notes,
      failed: attempt.failed,
      criticPasses: criticPasses > 0 ? criticPasses : undefined
    };
    args.stages.push(recoveryStage);
    emitStream(args.stream, { kind: "stage", stage: recoveryStage });
    emitStream(args.stream, {
      kind: "step",
      step: {
        id: recoveryStage.id,
        label: `File recovery ${attemptNumber} - ${providerInfo[recoveryStage.provider].label}`,
        detail: recoveryStage.failed ? "All models failed." : `Handled by ${stageModelLabel({ provider: recoveryStage.provider, model: recoveryStage.model })}.`,
        status: recoveryStage.failed ? "error" : "complete",
        completedAt: new Date().toISOString()
      }
    });
    emitTimeline(args.stream, { id: randomUUID(), kind: "stage", stageId: recoveryStage.id });
    await appendAudit(recoveryStage.failed ? "error" : "info", "session.extract-recovery", `Extraction recovery ${attemptNumber} via ${stageModelLabel(attempt.ref)}.`, {
      attempt: attemptNumber,
      provider: attempt.ref.provider,
      model: attempt.ref.model,
      failed: attempt.failed
    });
    if (recoveryStage.failed || !cleanOutput.trim()) continue;
    const recovered = extractGeneratedFilesFromText(cleanOutput);
    if (recovered.length > 0) return recovered;
  }
  return [];
}

async function runSession(input: SessionRunInput, stream?: SessionStreamController): Promise<SessionRun> {
  const runStart = Date.now();
  const originalPrompt = input.prompt.trim();
  if (!originalPrompt) throw new Error("Session run requires a prompt.");
  clearSessionCancel(input.projectPath);
  // Same key requestSessionCancel/abortLiveCalls use — threaded down to every
  // provider invoke this run makes so a Stop click can abort them directly.
  const cancelScope = directiveScopeKey(input.projectPath);

  // "/orchestration" (or "/orch") as the leading token is an explicit manual
  // command to run the build pipeline — it bypasses task-type inference
  // entirely. The command token is stripped; the remainder is the actual
  // build request and is what flows into routing/stages/design seeds. The
  // conversation record still stores originalPrompt (as typed, command
  // included) so history reflects what the user actually sent.
  const orchestrationCommand = parseOrchestrationCommand(originalPrompt);
  const forceBuildPipeline = orchestrationCommand !== null && orchestrationCommand.remainder.length > 0;
  const orchestrationCommandWithoutTarget = orchestrationCommand !== null && orchestrationCommand.remainder.length === 0;
  const prompt = orchestrationCommand ? orchestrationCommand.remainder || originalPrompt : originalPrompt;

  // Reference-image attachments (backend half only — composer attach UI is a
  // separate follow-up round). Normalisation never throws and is capped, so
  // this line can never affect a run that has no attachments: `images` is
  // simply an empty array, and every consumer below gates on images.length > 0.
  const images = normaliseAttachmentImages(input.attachments);

  if (orchestrationCommandWithoutTarget) {
    // "/orchestration" with nothing after it — nothing to build yet. Answer
    // as an ordinary chat turn asking what to build, rather than forcing an
    // empty build pipeline run.
    const createdAt = new Date().toISOString();
    const conversationId = input.conversationId ?? randomUUID();
    const promptHash = sha256(originalPrompt);
    const decision = await decidePolicy({ prompt: originalPrompt, preset: input.preset });
    const assistantText = "What would you like the build pipeline to make? Follow /orchestration with a description of the project, e.g. \"/orchestration a landing page for a coffee shop\".";
    const run: SessionRun = {
      id: randomUUID(),
      conversationId,
      createdAt,
      completedAt: new Date().toISOString(),
      promptSha256: promptHash,
      promptPreview: originalPrompt.slice(0, 180),
      rawPromptStored: false,
      projectPath: input.projectPath,
      pipelineName: "Chat",
      decision,
      steps: [],
      assistantText,
      warnings: []
    };
    await appendRunToConversation(run, originalPrompt);
    await writeSessionRun(run);
    emitStream(stream, { kind: "complete", run });
    return run;
  }

  const permissionMode = resolvePermissionMode(input);

  const createdAt = new Date().toISOString();
  const conversationId = input.conversationId ?? randomUUID();
  const promptHash = sha256(prompt);
  const policyStart = Date.now();
  const decision = await decidePolicy({
    prompt,
    preset: input.preset
  });
  const policyMs = Date.now() - policyStart;
  const previousRun = isAttributionQuestion(prompt) ? await previousConversationRun(input.conversationId) : null;
  const routeContext = shouldReusePreviousPipeline(prompt) ? await previousConversationTaskType(input.conversationId) : null;
  const routeLabel = routeLabelFromPrompt(prompt) ?? (shouldReusePreviousPipeline(prompt) ? await previousConversationRouteLabel(input.conversationId) : undefined);
  const effectiveDecision = applySessionRouteOverrides(prompt, decision.decision, routeContext);
  const effectiveDecisionResult: PolicyDecisionResult = { ...decision, decision: effectiveDecision };

  // "Set up a preview" is an OPERATION on the existing project, not a build —
  // serve the selected folder and open the rail instead of running the pipeline.
  // An explicit /orchestration command always wins over the preview pre-gate.
  if (!forceBuildPipeline && wantsProjectPreview(prompt)) {
    return runPreviewRequest({ input, prompt, conversationId, createdAt, promptHash, decision: effectiveDecisionResult, stream });
  }

  // Hoisted so shouldRunBuildPipeline's edit-intent rule can consult folder
  // truth (does the selected project actually have files?) before the build
  // gate decides, and so the build branch below reuses the same resolution
  // instead of resolving the workspace twice.
  const writable = await resolveActiveProjectWorkspace(input.projectPath);
  const editableProject = writable ? await projectHasSourceFiles(writable.path) : false;

  // Real multi-model build pipeline (plan -> front end -> functional) for "build me X".
  // A PINNED model (not Auto Router) means a direct chat with that model, so automatic
  // orchestration never fires when one is pinned (Lachy: "if the model is not on Auto Router,
  // there should be NO orchestration"). Only an explicit /orchestration command
  // (forceBuildPipeline) still runs the pipeline with a pinned model leading the stages.
  if (forceBuildPipeline || (!input.modelOverride && shouldRunBuildPipeline(prompt, effectiveDecision, decision.source, editableProject))) {
    const singleFile = wantsSingleFileFrontend(prompt);
    emitTimeline(stream, timelineText("I’ll run this through the build pipeline and turn the model output into real project files."));
    if (forceBuildPipeline) {
      emitTimeline(stream, timelineText("Build pipeline invoked manually via /orchestration."));
    }
    if (input.modelOverride) {
      emitTimeline(stream, timelineText(`Calling ${overrideDisplayLabel(input.modelOverride)} directly for every stage. The usual chain only steps in if it fails.`));
    }
    emitTimeline(stream, { id: randomUUID(), kind: "route", label: "Build", pipelineName: "Build Orchestration Pipeline" });
    emitStream(stream, {
      kind: "step",
      step: {
        id: "route",
        label: input.modelOverride ? `Calling ${overrideDisplayLabel(input.modelOverride)} directly` : "Route through Metis Policy",
        detail: input.modelOverride ? "Direct call to your pinned model for the primary attempt of each stage." : "Selected the build pipeline.",
        status: "complete",
        completedAt: new Date().toISOString()
      }
    });
    const metisFile = await loadProjectMetisFile(writable?.path ?? input.projectPath);
    const metisOperations: AgentOperation[] = [];
    if (metisFile) {
      const metisOp: AgentOperation = {
        id: randomUUID(),
        kind: "context_load",
        label: "Read METIS.md",
        target: join(resolve(writable?.path ?? input.projectPath ?? ""), "METIS.md"),
        status: "complete",
        charCount: metisFile.chars,
        permission: "filesystem.read",
        detail: "Project instructions loaded into every stage prompt."
      };
      metisOperations.push(metisOp);
      emitTimeline(stream, { id: randomUUID(), kind: "operations", title: "Read METIS.md", operationIds: [metisOp.id] });
    }
    // CHECK-FIRST (owner's principle: an ongoing-work tool assumes an existing
    // project and looks before deciding anything): every build-branch run
    // against a writable workspace reads the folder FIRST, before create-vs-edit
    // is decided, and surfaces that check as a visible operation — not just a
    // silent internal read.
    const projectCheckFiles = writable ? await readExistingProjectFiles(writable.path) : [];
    if (writable) {
      const checkOp: AgentOperation = {
        id: randomUUID(),
        kind: "context_load",
        label: "Checked the project folder",
        target: writable.path,
        status: "complete",
        charCount: projectCheckFiles.reduce((sum, file) => sum + file.content.length, 0),
        permission: "filesystem.read",
        detail: projectCheckSummary(projectCheckFiles)
      };
      metisOperations.push(checkOp);
      emitStream(stream, { kind: "operation", operation: checkOp });
      emitTimeline(stream, { id: randomUUID(), kind: "operations", title: "Checked the project folder", detail: projectCheckSummary(projectCheckFiles), operationIds: [checkOp.id] });
    }
    // Folder-truth gate: EDIT whenever the folder has files and the user isn't
    // explicitly demanding a fresh build. A fresh-build request against a
    // non-empty folder is allowed (the user may genuinely want a redo) but
    // gets a loud warning first, since it overwrites same-named files.
    const freshBuildRequested = wantsFreshBuild(prompt);
    const editContextFiles = !freshBuildRequested && writable ? projectCheckFiles : [];
    const editMode = editContextFiles.length > 0;
    if (freshBuildRequested && projectCheckFiles.length > 0) {
      emitTimeline(stream, timelineText(`Building fresh into a non-empty folder — same-named files will be overwritten.`));
    }
    let stages: OrchestrationStage[];
    let designSeed: Awaited<ReturnType<typeof runOrchestratedStages>>["designSeed"] | undefined;
    // N-agent fan-out (docs/DRILL_PLAN.md Phase 5, sub-round 5a): fanoutMeta
    // attaches to SessionRun for the renderer; fanoutFiles, when set, is the
    // already-ledger-merged file list and REPLACES the normal
    // extractProjectFiles(stages) call below (that helper's own last-write-
    // wins dedupe doesn't know about the fan-out ledger's claim rules).
    let fanoutMeta: SessionRun["fanout"];
    let fanoutFiles: GeneratedFile[] | null = null;
    const conversationContext = await recentConversationContext(input.conversationId);
    if (editMode) {
      emitTimeline(
        stream,
        timelineText(`This reads as an edit to ${writable!.name} — I loaded ${editContextFiles.length} existing files and will change only what's needed. No rebuild, no new design.`)
      );
      const readOp: AgentOperation = {
        id: randomUUID(),
        kind: "context_load",
        label: `Read ${editContextFiles.length} project files`,
        target: writable!.path,
        status: "complete",
        charCount: editContextFiles.reduce((sum, file) => sum + file.content.length, 0),
        permission: "filesystem.read",
        detail: editContextFiles.map((file) => file.path).join(", ").slice(0, 400)
      };
      metisOperations.push(readOp);
      emitStream(stream, { kind: "operation", operation: readOp });
      emitTimeline(stream, { id: randomUUID(), kind: "operations", title: "Read project files", operationIds: [readOp.id] });

      const { stages: stageConfigs } = await resolveAgenticStages(prompt, input.modelOverride);
      const editConfig = stageConfigs.find((config) => config.templateRole === "frontend") ?? stageConfigs[0];
      const fileDump = editContextFiles.map((file) => `\`${file.path}\`\n\`\`\`\n${file.content}\n\`\`\``).join("\n\n");
      let editPrompt = `You are EDITING an existing project. Do NOT redesign or rebuild it — preserve its current structure, style, and content except where the user's request requires changes. You may ADD new files (e.g. a new page) alongside changed ones when the request calls for it.\n\nUser request:\n${prompt}\n\nCurrent project files:\n${fileDump}\n\nReturn the complete files you changed or added — and nothing else. Before each fenced code block, put the file path in backticks on its own line. One short sentence describing the change, then the files.`;
      if (conversationContext) editPrompt = `Recent conversation (for continuity — the newest user request is the task):\n${conversationContext}\n\n${editPrompt}`;
      if (metisFile) editPrompt = `${metisFilePromptBlock(metisFile)}\n\n${editPrompt}`;
      const editKnowledge = await retrieveKnowledgeForPrompt(writable?.path, prompt);
      if (editKnowledge) {
        editPrompt = `${editKnowledge.block}${editPrompt}`;
        metisOperations.push(editKnowledge.operation);
        emitStream(stream, { kind: "operation", operation: editKnowledge.operation });
        emitTimeline(stream, { id: randomUUID(), kind: "operations", title: editKnowledge.operation.label, operationIds: [editKnowledge.operation.id] });
      }
      if (images.length > 0) {
        editPrompt += attachmentNoteFor(images.length);
      }
      // Stage id "frontend" keeps extraction recovery's existing output lookup working.
      const editCallContext: StageCallContext = { stream, stageId: "frontend", stageLabel: "Edit existing project", scope: cancelScope };
      const attempt = await callStageWithFallback(editConfig.chain, editPrompt, editConfig.gatewayPreference, editCallContext, images.length > 0 ? images : undefined);
      const cleanOutput = stripThinkBlocks(attempt.output);
      const editStage: OrchestrationStage = {
        id: "frontend",
        label: "Edit existing project",
        provider: attempt.ref.provider,
        model: attempt.ref.model,
        output: cleanOutput,
        fallbackNotes: attempt.notes,
        failed: attempt.failed
      };
      stages = [editStage];
      designSeed = undefined;
      emitStream(stream, { kind: "stage", stage: editStage });
      emitStream(stream, {
        kind: "step",
        step: {
          id: "frontend",
          label: `Edit existing project - ${providerInfo[attempt.ref.provider].label}`,
          detail: editStage.failed ? "All models failed." : `Handled by ${stageModelLabel(attempt.ref)}.`,
          status: editStage.failed ? "error" : "complete",
          completedAt: new Date().toISOString()
        }
      });
      emitTimeline(stream, { id: randomUUID(), kind: "stage", stageId: "frontend" });
      await appendAudit(editStage.failed ? "error" : "info", "session.edit", `Edit stage via ${stageModelLabel(attempt.ref)}.`, {
        provider: attempt.ref.provider,
        model: attempt.ref.model,
        files: editContextFiles.length,
        failed: editStage.failed
      });
    } else {
      // Plan mode never runs fan-out — same as the single pipeline, which
      // stops after its own "plan" stage in permissionMode "plan" (see
      // runOrchestratedStages) rather than spending calls on a full build.
      const fanoutResult = permissionMode !== "plan" && (await shouldAttemptFanout(singleFile))
        ? await runFanoutPipeline(prompt, stream, input.modelOverride, input.projectPath, metisFile, conversationContext, images.length > 0 ? images : undefined)
        : null;
      if (fanoutResult) {
        stages = fanoutResult.stages;
        designSeed = fanoutResult.designSeed;
        fanoutMeta = fanoutResult.fanout;
        fanoutFiles = fanoutResult.files;
      } else {
        ({ stages, designSeed } = await runOrchestratedStages(prompt, stream, input.modelOverride, input.projectPath, metisFile, permissionMode, conversationContext, images.length > 0 ? images : undefined));
      }
    }
    let files: GeneratedFile[] = [];
    let projectResult: ProjectToolResult | undefined;
    let repairCount = 0;
    if (permissionMode === "plan") {
      // Plan mode: no extraction, no writes, no commands, no repair/recovery —
      // the stage loop already stopped after "plan" (docs/FABLE_PLANS.md §24).
    } else {
    // Fan-out already merged its sub-agents' files through the claim ledger
    // (docs/DRILL_PLAN.md Phase 5, sub-round 5a) — extractProjectFiles' own
    // last-write-wins dedupe would ignore those claim decisions, so use the
    // ledger-clean list directly whenever fan-out ran.
    files = fanoutFiles ?? extractProjectFiles(stages);
    // Never give up on 0 extracted files without a fight — ask the build model
    // again, explicitly, before conceding nothing was written.
    if (files.length === 0) {
      throwIfCancelled(input.projectPath);
      files = await runExtractionRecovery({ prompt, stages, override: input.modelOverride, stream, metisFile, scope: cancelScope });
    }
    if (files.length > 0) {
      const gate = await gatePermission({
        stream,
        mode: permissionMode,
        scope: "filesystem.write",
        target: writable?.path ?? "app-managed workspace",
        projectPath: writable?.path,
        detail: `Write ${files.length} file${files.length === 1 ? "" : "s"} into ${writable?.name ?? "the app workspace"}?`
      });
      if (gate.proceed) {
        emitTimeline(stream, timelineText(`I’ve got the generated files. Writing them into ${writable?.name ?? "the app workspace"} now.`));
        projectResult = await writeProjectFiles(files, writable, { singleFile });
      } else {
        emitTimeline(stream, timelineText(`Permission denied — skipped writing ${files.length} file${files.length === 1 ? "" : "s"}.`));
      }
    } else {
      emitTimeline(stream, timelineText("I could not extract a complete project file from the model output, so I am leaving the folder unchanged."));
    }
    // Self-healing: if verification failed, feed the errors back and retry.
    if (projectResult && !projectResult.verified) {
      throwIfCancelled(input.projectPath);
      const repaired = await runRepairPasses({
        prompt,
        files,
        projectResult,
        writable,
        singleFile,
        override: input.modelOverride,
        stages,
        stream,
        metisFile,
        scope: cancelScope
      });
      projectResult = repaired.projectResult;
      repairCount = repaired.repairCount;
    }
    }
    const fileCount = projectResult ? projectResult.artifacts.filter((artifact) => artifact.kind === "file" || artifact.kind === "file_create").length : 0;
    const targetName = projectResult?.writeMode === "selected-project" ? writable?.name : "the app workspace";
    const operations = [...metisOperations, ...(projectResult ? operationsForProject(projectResult) : [])];
    if (projectResult) emitStream(stream, { kind: "project", project: projectResult });
    for (const operation of operations ?? []) emitStream(stream, { kind: "operation", operation });
    const fileOperationIds = (operations ?? [])
      .filter((operation) => operation.kind === "file_create" || operation.kind === "file_edit" || operation.kind === "directory_create")
      .map((operation) => operation.id);
    const checkOperationIds = (operations ?? [])
      .filter((operation) => operation.kind === "command" || operation.kind === "browser_check")
      .map((operation) => operation.id);
    if (fileOperationIds.length > 0) {
      emitTimeline(stream, {
        id: randomUUID(),
        kind: "operations",
        title: "File writes",
        detail: `${fileCount} file${fileCount === 1 ? "" : "s"} written`,
        operationIds: fileOperationIds
      });
    }
    if (checkOperationIds.length > 0) {
      emitTimeline(stream, timelineText("Now I’m checking syntax and loading the preview."));
      emitTimeline(stream, {
        id: randomUUID(),
        kind: "operations",
        title: "Verification",
        detail: projectResult?.verificationDetail,
        operationIds: checkOperationIds
      });
    }
    const timeline = buildRunTimelineForBuild({ stages, projectResult, operations, fileCount, targetName });
    const stageSteps: SessionPipelineStep[] = [
      { id: "route", label: "Route through Metis Policy", detail: "Selected the build pipeline.", status: "complete" },
      ...stages.map((stage) => ({
        id: stage.id,
        label: `${stage.label} — ${providerInfo[stage.provider].label}`,
        detail: stage.failed ? "All models failed." : `Handled by ${stageModelLabel({ provider: stage.provider, model: stage.model })}.`,
        status: (stage.failed ? "error" : "complete") as SessionPipelineStatus
      }))
    ];
    const run: SessionRun = {
      id: randomUUID(),
      conversationId,
      createdAt,
      completedAt: new Date().toISOString(),
      promptSha256: promptHash,
      promptPreview: originalPrompt.slice(0, 180),
      rawPromptStored: false,
      projectPath: projectResult?.workspacePath ?? input.projectPath,
      pipelineName: "Build Orchestration Pipeline",
      routeLabel: "Build",
      decision: effectiveDecisionResult,
      projectResult,
      operations,
      timeline,
      steps: stageSteps,
      assistantText: projectResult
        ? `I ran this through the build pipeline and wrote ${fileCount} file${fileCount === 1 ? "" : "s"} into ${targetName}.${
            repairCount > 0
              ? ` Verification flagged issues, so I ran ${repairCount} repair pass${repairCount === 1 ? "" : "es"} — ${
                  projectResult.verified ? "it now verifies clean" : "it still fails; the trace below has the details"
                }.`
              : ""
          } Each stage is below.`
        : "I ran this through the orchestration pipeline — planning, the front end, then the functionality. Each stage is below.",
      stages,
      warnings: [
        ...(input.projectPath && !writable ? ["Project folder permission was missing or revoked, so files were written to the app-managed workspace instead."] : []),
        ...(projectResult && !projectResult.verified ? [projectResult.verificationDetail] : [])
      ],
      designSeed: designSeed ? { id: designSeed.id, name: designSeed.name } : undefined,
      fanout: fanoutMeta
    };
    if (!projectResult) {
      run.assistantText = "I ran this through the build pipeline, but no complete project files were extracted. I left the folder unchanged.";
      run.warnings = [...(run.warnings ?? []), "No complete files were extracted from the build stages; nothing was written."];
    }
    if (permissionMode === "plan") {
      // Graph-driven stages keep the graph node's own id (docs/FABLE_PLANS.md
      // section 25) — fall back to the first stage (always the plan-role
      // stage in plan mode, since the loop breaks right after it) when the
      // named "plan" id isn't present.
      const planStage = stages.find((stage) => stage.id === "plan") ?? stages[0];
      run.assistantText = `${planStage?.output ?? "I put together a plan."}\n\nPlan mode — nothing was written. Switch to Auto and rerun to build it.`;
      run.pipelineName = "Plan Mode";
    }
    // Record the conversation turn with the prompt as the user actually typed
    // it (including a leading /orchestration command, if any) — the stripped
    // `prompt` is only for routing/stage inputs.
    await appendRunToConversation(run, originalPrompt);
    await writeSessionRun(run);
    emitStream(stream, { kind: "complete", run });
    return run;
  }

  // DRILL_PLAN PF5a: a pinned model is a direct chat with no routing decision,
  // so the pipeline name must not leak the auto-router's task_type framing —
  // "Front End Orchestration Pipeline" makes no sense once the router never
  // ran. Pinned runs get a neutral name; Auto Router keeps the task-type name.
  const pipelineName = input.modelOverride ? "Direct chat" : pipelineNameFor(effectiveDecision);
  // A pinned model is a pure direct chat: no orchestration means no chat-path project
  // file creation / design seed either, so this gates on Auto Router (no modelOverride).
  const includeProjectTools = !input.modelOverride && shouldCreateFrontendProject(prompt, effectiveDecision);
  const steps = initialPipelineSteps(pipelineName, effectiveDecision, includeProjectTools, input.modelOverride);
  steps[0] = completeStep(steps[0]);

  // The audit trail always records the pipeline event (internal record stays
  // intact); the "orchestration" step only exists in `steps` for an Auto
  // Router run — a pinned run's minimal step list has none, so this is found
  // by id rather than assumed at a fixed index.
  const orchestrationAudit = await appendAudit("info", "session.pipeline", `Running ${pipelineName}.`, {
    pipeline: pipelineName,
    task_type: effectiveDecision.task_type,
    prompt_sha256: promptHash
  });
  const orchestrationIndex = steps.findIndex((step) => step.id === "orchestration");
  if (orchestrationIndex >= 0) steps[orchestrationIndex] = completeStep(steps[orchestrationIndex], orchestrationAudit.id);

  const route = effectiveDecision.selected_route;
  const override = input.modelOverride;
  const provider = override ? override.provider : providerFromRoute(route.provider, route.runtime, route.kind);
  const model = override ? resolveOverrideModel(override) : route.model ?? providerInfo[provider].defaultModel ?? "auto";
  const effectiveRouteLabel = override ? overrideDisplayLabel(override) : routeLabel;
  const writableWorkspace = await resolveActiveProjectWorkspace(input.projectPath);
  // Fast lane (bug L4b): a short, plain general_chat turn ("Test", "hi") skips
  // the project-snapshot walk and knowledge-bank retrieval below — both add
  // real tokens/latency that a trivial turn never needed. Route ceremony,
  // METIS.md, and everything else stays exactly as before.
  const fastLane = isFastLaneEligible(prompt, effectiveDecision);
  const snapshotStart = Date.now();
  const projectSnapshot = !fastLane && writableWorkspace ? await buildProjectSnapshot(writableWorkspace.path) : undefined;
  const snapshotMs = Date.now() - snapshotStart;
  const metisFile = await loadProjectMetisFile(writableWorkspace?.path ?? input.projectPath);
  const metisOperations: AgentOperation[] = [];
  if (metisFile) {
    const metisOp: AgentOperation = {
      id: randomUUID(),
      kind: "context_load",
      label: "Read METIS.md",
      target: join(resolve(writableWorkspace?.path ?? input.projectPath ?? ""), "METIS.md"),
      status: "complete",
      charCount: metisFile.chars,
      permission: "filesystem.read",
      detail: "Project instructions loaded into every stage prompt."
    };
    metisOperations.push(metisOp);
    emitStream(stream, { kind: "operation", operation: metisOp });
    emitTimeline(stream, { id: randomUUID(), kind: "operations", title: "Read METIS.md", operationIds: [metisOp.id] });
  }
  const projectCommandOperations = await maybeRunRequestedProjectCommand(prompt, writableWorkspace, permissionMode, stream);
  // DRILL_PLAN PF5a: a pinned model emits zero route ceremony — no "calling X
  // directly" line, no route chip, no "recording the trace" line further
  // below — just the answer and the completion event. This used to be
  // `Boolean(override) || ...`, which forced ceremony on for every pinned
  // run; Auto Router behavior (the `shouldStreamRouteCeremony` call) is
  // unchanged.
  const showRouteCeremony = !override && shouldStreamRouteCeremony(prompt, effectiveDecision, includeProjectTools, projectCommandOperations);
  if (showRouteCeremony) {
    emitTimeline(
      stream,
      timelineText(override ? `Calling ${overrideDisplayLabel(override)} directly. Skipping the router.` : "I’m checking the route and preparing the selected model.")
    );
    emitTimeline(stream, { id: randomUUID(), kind: "route", label: effectiveRouteLabel ?? pipelineName.replace(/\s*Orchestration Pipeline$/i, "").replace(/\s*Assistant Pipeline$/i, ""), pipelineName });
  }
  // Design seed: only for the chat-path project-tools flow (frontend builds
  // via createFrontendProject), and never overrides explicit user taste.
  const chatDesignSeed = includeProjectTools ? pickDesignSeed(prompt) : undefined;
  if (chatDesignSeed) emitTimeline(stream, timelineText(designSeedTimelineText(chatDesignSeed)));
  const chatConversationContext = await recentConversationContext(input.conversationId);
  const knowledgeStart = Date.now();
  const chatKnowledge = fastLane ? null : await retrieveKnowledgeForPrompt(writableWorkspace?.path, prompt);
  const knowledgeMs = Date.now() - knowledgeStart;
  if (chatKnowledge) {
    metisOperations.push(chatKnowledge.operation);
    emitStream(stream, { kind: "operation", operation: chatKnowledge.operation });
    emitTimeline(stream, { id: randomUUID(), kind: "operations", title: chatKnowledge.operation.label, operationIds: [chatKnowledge.operation.id] });
  }
  let sessionPrompt = sessionProviderPrompt(prompt, effectiveDecision, pipelineName, previousRun, projectSnapshot, chatDesignSeed, metisFile, chatConversationContext, chatKnowledge?.block, !fastLane);
  if (images.length > 0) {
    sessionPrompt += attachmentNoteFor(images.length);
  }
  const chatImages = images.length > 0 ? images : undefined;
  const overrideWarnings: string[] = [];
  let providerResult: ProviderInvokeResult;
  const providerStart = Date.now();
  // Oracle v0.3 (DRILL_PLAN O4): if Oracle already drafted a COMPLETE answer
  // to this EXACT assembled prompt (byte-identical, hash-matched) for this
  // exact pinned local model, serve it instantly instead of re-generating.
  // The draft was produced by the same model with the same default sampling,
  // so it is a legitimate sample of the model's answer, not a shortcut fake.
  // Conservative gates: pinned + local Ollama + no images + experiment flag
  // on + exact hash match + draft finished naturally + one-shot claim.
  let oracleServed = false;
  const servedDraft =
    override && provider === "ollama" && !chatImages && (await readStoreValue<boolean>("prewarmEnabled", false))
      ? takeServableDraft(model, sha256(sessionPrompt))
      : null;
  if (servedDraft) {
    oracleServed = true;
    if (servedDraft.thoughts) emitStream(stream, { kind: "thought_delta", delta: servedDraft.thoughts });
    emitStream(stream, { kind: "message_delta", delta: servedDraft.text });
    const servedAudit = await appendAudit("info", "session.provider", "Oracle served the pre-drafted response for an exact prompt match.", {
      provider,
      model,
      prompt_sha256: promptHash
    });
    providerResult = {
      provider,
      model,
      output: servedDraft.text,
      thoughts: servedDraft.thoughts,
      source: "ollama",
      auditId: servedAudit.id,
      ttftMs: Date.now() - providerStart
    };
  } else try {
    providerResult = await invokeProvider({ provider, model, prompt: sessionPrompt, images: chatImages }, stream, cancelScope);
  } catch (error) {
    // A Stop-button cancellation must end the run immediately — never trigger
    // the pinned-model fallback below, which would otherwise treat an abort
    // as "this model failed" and quietly retry against the default model.
    if (isCancellationError(error)) throw error;
    if (!override) throw error;
    // A pinned model can be a hand-typed custom entry — fall back to the provider default instead of failing the run.
    const fallbackModel = providerInfo[provider].defaultModel ?? "auto";
    overrideWarnings.push(
      `Failed to call ${overrideDisplayLabel(override)} (${error instanceof Error ? error.message : String(error)}), falling back to ${providerInfo[provider].label} (${fallbackModel}).`
    );
    emitTimeline(stream, timelineText(`Couldn’t reach ${overrideDisplayLabel(override)} — falling back to ${providerInfo[provider].label} (${fallbackModel}).`));
    providerResult = await invokeProvider({ provider, model: fallbackModel, prompt: sessionPrompt, images: chatImages }, stream, cancelScope);
  }
  const providerMs = Date.now() - providerStart;
  // General-chat action proposals (bug L6): reuses the exact Manager-tab
  // machinery (extractManagerActions / validateManagerAction / MANAGER_ACTION_KINDS
  // above, and the metis-manager:action executor) so a normal chat turn gets
  // the same approve-first action capability without duplicating any of it.
  // Gated to the same !fastLane flag passed into sessionProviderPrompt above,
  // so a fast-lane turn (never asked to produce a block) skips the parse too.
  let chatActions: ManagerAction[] | undefined;
  if (!fastLane) {
    const extracted = extractManagerActions(providerResult.output);
    if (extracted.reply !== providerResult.output) providerResult = { ...providerResult, output: extracted.reply };
    chatActions = extracted.actions;
    if (chatActions?.length) {
      await appendAudit("info", "manager.action", "Chat turn proposed actions.", {
        kinds: chatActions.map((action) => action.kind)
      });
    }
  }
  if (showRouteCeremony) emitTimeline(stream, timelineText("The selected model responded. I’m recording the trace and any follow-up project tools."));
  // Found by id, not assumed at index 2 — a pinned run's minimal step list
  // (route, provider, finalize) still has "provider" at index 1, not 2.
  const providerIndex = steps.findIndex((step) => step.id === "provider");
  if (providerIndex >= 0) steps[providerIndex] = completeStep(steps[providerIndex], providerResult.auditId);

  let projectResult: ProjectToolResult | undefined;
  let noProjectFilesWritten = false;
  const projectToolsIndex = steps.findIndex((step) => step.id === "project-tools");
  if (projectToolsIndex >= 0 && permissionMode === "plan") {
    // Plan mode: chat-path project tools are disabled entirely — no writes,
    // no commands (docs/FABLE_PLANS.md section 24).
    steps[projectToolsIndex] = {
      ...steps[projectToolsIndex],
      status: "skipped",
      detail: "Plan mode — project tools are disabled, so nothing was written.",
      completedAt: new Date().toISOString()
    };
  } else if (projectToolsIndex >= 0) {
    const gate = await gatePermission({
      stream,
      mode: permissionMode,
      scope: "filesystem.write",
      target: writableWorkspace?.path ?? "app-managed workspace",
      projectPath: writableWorkspace?.path,
      detail: `Write generated project files into ${writableWorkspace?.name ?? "the app workspace"}?`
    });
    if (!gate.proceed) {
      emitTimeline(stream, timelineText("Permission denied — skipped writing project files."));
      noProjectFilesWritten = true;
      steps[projectToolsIndex] = {
        ...steps[projectToolsIndex],
        status: "skipped",
        detail: "Permission was denied, so no project files were written.",
        completedAt: new Date().toISOString()
      };
    } else {
    projectResult = await createFrontendProject(prompt, providerResult, writableWorkspace ?? undefined);
    if (projectResult) {
      const projectAudit = await appendAudit("info", "project.write", `Generated frontend project at ${projectResult.projectRoot}.`, {
        projectRoot: projectResult.projectRoot,
        workspacePath: projectResult.workspacePath,
        writeMode: projectResult.writeMode,
        previewUrl: projectResult.previewUrl,
        verified: projectResult.verified,
        artifact_count: projectResult.artifacts.length
      });
      steps[projectToolsIndex] = completeStep(
        {
          ...steps[projectToolsIndex],
          detail: `Created ${projectResult.artifacts.filter((artifact) => artifact.kind === "file" || artifact.kind === "file_create").length} files in ${
            writableWorkspace?.name ?? "the app-managed workspace"
          } and started ${projectResult.previewUrl ?? "the local preview"}.`
        },
        projectAudit.id
      );
    } else {
      noProjectFilesWritten = true;
      steps[projectToolsIndex] = {
        ...steps[projectToolsIndex],
        status: "skipped",
        detail: "No complete files were produced, so nothing was written.",
        completedAt: new Date().toISOString()
      };
    }
    }
  }

  const verifyIndex = steps.findIndex((step) => step.id === "verify");
  if (verifyIndex >= 0) {
    const verifyAudit = await appendAudit(projectResult?.verified === false ? "warning" : "info", "session.verify", projectResult ? projectResult.verificationDetail : `Prepared verification stage for ${pipelineName}.`, {
      pipeline: pipelineName,
      task_type: effectiveDecision.task_type,
      previewUrl: projectResult?.previewUrl,
      verified: projectResult?.verified
    });
    steps[verifyIndex] = completeStep(
      {
        ...steps[verifyIndex],
        detail: projectResult ? projectResult.verificationDetail : steps[verifyIndex].detail
      },
      verifyAudit.id
    );
  }

  const finalizeAudit = await appendAudit("info", "session.complete", `Session run completed through ${pipelineName}.`, {
    pipeline: pipelineName,
    provider,
    model,
    prompt_sha256: promptHash
  });
  const finalizeIndex = steps.findIndex((step) => step.id === "finalize");
  if (finalizeIndex >= 0) steps[finalizeIndex] = completeStep(steps[finalizeIndex], finalizeAudit.id);

  const run: SessionRun = {
    id: randomUUID(),
    conversationId,
    createdAt,
    completedAt: new Date().toISOString(),
    promptSha256: promptHash,
    promptPreview: prompt.slice(0, 180),
    rawPromptStored: false,
    projectPath: projectResult?.workspacePath ?? input.projectPath,
    pipelineName,
    routeLabel: effectiveRouteLabel,
    projectSnapshot,
    decision: effectiveDecisionResult,
    providerResult,
    modelThoughts: providerResult.thoughts,
    ttftMs: providerResult.ttftMs,
    oracleServed: oracleServed || undefined,
    projectResult,
    operations: [...metisOperations, ...projectCommandOperations, ...(projectResult ? operationsForProject(projectResult) : [])],
    steps,
    assistantText: buildAssistantText(input, effectiveDecision, pipelineName, providerResult, projectResult),
    outputUrl: projectResult?.previewUrl,
    warnings: [
      ...overrideWarnings,
      ...visibleBackendWarnings(decision.warnings),
      ...(input.projectPath && !writableWorkspace && projectToolsIndex >= 0
        ? ["Project folder permission was missing or revoked, so Metis used the app-managed generated-projects folder."]
        : []),
      ...(providerResult.source === "placeholder" ? [providerResult.output] : []),
      ...projectCommandOperations.filter((operation) => operation.status !== "complete").map((operation) => operation.detail ?? operation.label),
      ...(projectResult && !projectResult.verified ? [projectResult.verificationDetail] : []),
      ...(noProjectFilesWritten ? ["The model did not return complete files, so no project files were written."] : [])
    ],
    ...(chatDesignSeed ? { designSeed: { id: chatDesignSeed.id, name: chatDesignSeed.name } } : {}),
    ...(chatActions?.length ? { actions: chatActions } : {})
  };
  if (permissionMode === "plan" && projectToolsIndex >= 0) {
    run.assistantText = `${run.assistantText}\n\nPlan mode — nothing was written. Switch to Auto and rerun to build it.`;
  }

  // Bug L4b instrumentation: surface where a chat turn's time actually went
  // (policy route, snapshot build, knowledge retrieval, provider invoke) so a
  // slow turn is visible in the audit trail instead of just "it took a while".
  // DRILL_PLAN E1: ttftMs (time to first streamed token, undefined for a
  // non-streaming provider call) rides along on the same line so a prewarm
  // A/B comparison can be read straight from the audit log.
  const totalMs = Date.now() - runStart;
  await appendAudit(
    "info",
    "session.timing",
    `Chat turn timing — policy ${policyMs}ms, snapshot ${snapshotMs}ms, knowledge ${knowledgeMs}ms, provider ${providerMs}ms, total ${totalMs}ms${
      typeof run.ttftMs === "number" ? `, ttft ${run.ttftMs}ms` : ""
    }.`,
    {
      policyMs,
      snapshotMs,
      knowledgeMs,
      providerMs,
      totalMs,
      ttftMs: run.ttftMs,
      fastLane,
      task_type: effectiveDecision.task_type,
      provider,
      model
    }
  );

  await appendRunToConversation(run, prompt);
  await writeSessionRun(run);
  // Fire-and-forget: never awaited, so a slow/unavailable local model can
  // never delay or fail this run's return. See maybeAutoTitleConversation
  // for the one-shot / manual-rename guards and the local-model prompt.
  void maybeAutoTitleConversation(conversationId, prompt, run.assistantText).catch(() => {});
  emitStream(stream, { kind: "complete", run });
  return run;
}

async function runLabExperiment(prompt?: string): Promise<LabExperimentResult> {
  const totalStart = Date.now();
  const createdAt = new Date().toISOString();
  const experimentPrompt =
    prompt?.trim() ||
    "In one concise sentence, explain why an orchestration layer can outperform a single model on real work.";
  const steps: LabExperimentStep[] = [];
  const policyStart = Date.now();
  const decision = await decidePolicy({
    prompt: experimentPrompt,
    preset: "balanced"
  });
  const policyMs = Date.now() - policyStart;
  const pipelineName = pipelineNameFor(decision.decision);
  steps.push({
    id: "policy",
    label: "Policy route",
    detail: `${decision.decision.task_type} -> ${decision.decision.selected_route.kind}`,
    status: "complete",
    durationMs: policyMs
  });

  const providerStatuses = await listProviders();
  const configuredCloud = providerStatuses.find(
    (provider) => provider.provider !== "ollama" && provider.configured && provider.status !== "unavailable"
  );
  const selectedProvider = configuredCloud?.provider ?? "ollama";
  const selectedModel = configuredCloud?.defaultModel ?? providerInfo[selectedProvider].defaultModel ?? "auto";
  steps.push({
    id: "provider-select",
    label: "Provider selection",
    detail: configuredCloud
      ? `Using configured ${providerInfo[selectedProvider].label} key.`
      : "No cloud key is saved in Orchestrator settings, so trying the local Ollama route.",
    status: configuredCloud ? "complete" : "warning"
  });

  const providerStart = Date.now();
  const providerResult = await invokeProvider({
    provider: selectedProvider,
    model: selectedModel,
    prompt: [
      "You are the live experiment probe inside Metis Orchestrator.",
      "Keep the answer under 35 words.",
      "",
      experimentPrompt
    ].join("\n")
  });
  const providerMs = Date.now() - providerStart;
  const live = providerResult.source !== "placeholder";
  steps.push({
    id: "model-call",
    label: "Model call",
    detail: `${providerInfo[selectedProvider].label} / ${selectedModel} / ${providerResult.source}`,
    status: live ? "complete" : "warning",
    durationMs: providerMs
  });
  const totalMs = Date.now() - totalStart;
  steps.push({
    id: "telemetry",
    label: "Telemetry",
    detail: `${totalMs}ms total, ~${estimateTokens(providerResult.output)} output tokens, ${decision.warnings.length} policy warning${decision.warnings.length === 1 ? "" : "s"}.`,
    status: decision.warnings.length ? "warning" : "complete",
    durationMs: totalMs
  });

  const verifierStatus = live ? "complete" : "warning";
  const pipelineNodes: LabExperimentResult["pipelineNodes"] = [
    {
      id: "prompt",
      label: "Prompt",
      kind: "prompt",
      status: "complete",
      detail: `~${estimateTokens(experimentPrompt)} tokens`
    },
    {
      id: "policy",
      label: "Metis Policy",
      kind: "policy",
      status: "complete",
      detail: `${decision.source}, ${policyMs}ms`
    },
    {
      id: "router",
      label: "Router",
      kind: "router",
      status: configuredCloud ? "complete" : "warning",
      detail: configuredCloud ? "Configured cloud route available" : "Fell back to local route"
    },
    {
      id: "model",
      label: providerInfo[selectedProvider].label,
      kind: "model",
      status: live ? "complete" : "warning",
      provider: selectedProvider,
      model: selectedModel,
      detail: `${providerResult.source}, ${providerMs}ms`
    },
    {
      id: "verifier",
      label: "Runtime verifier",
      kind: "verifier",
      status: verifierStatus,
      detail: live ? "Live provider response captured" : "Provider returned fallback placeholder"
    },
    {
      id: "result",
      label: "Result",
      kind: "result",
      status: live ? "complete" : "warning",
      detail: `~${estimateTokens(providerResult.output)} output tokens`
    }
  ];
  const pipelineEdges: LabExperimentResult["pipelineEdges"] = [
    { from: "prompt", to: "policy", label: "classify", status: "complete" },
    { from: "policy", to: "router", label: "route", status: "complete" },
    { from: "router", to: "model", label: selectedProvider, status: configuredCloud ? "complete" : "warning" },
    { from: "model", to: "verifier", label: "capture", status: live ? "complete" : "warning" },
    { from: "verifier", to: "result", label: "summarise", status: live ? "complete" : "warning" }
  ];

  const result: LabExperimentResult = {
    id: randomUUID(),
    createdAt,
    prompt: experimentPrompt,
    mode: live ? "live" : "fallback",
    provider: selectedProvider,
    model: selectedModel,
    output: providerResult.output,
    route: {
      pipelineName,
      taskType: decision.decision.task_type,
      decisionSource: decision.source,
      selectedRoute: decision.decision.selected_route,
      fallbackCount: decision.decision.fallback_routes?.length ?? 0
    },
    metrics: [
      { label: "Total latency", value: `${totalMs} ms`, detail: "Wall time inside the Orchestrator runtime." },
      { label: "Policy latency", value: `${policyMs} ms`, detail: "Time to classify and choose a route." },
      { label: "Provider latency", value: `${providerMs} ms`, detail: "Time spent waiting for the selected model/provider." },
      { label: "Prompt proxy", value: `~${estimateTokens(experimentPrompt)} tokens`, detail: `${experimentPrompt.length} characters / 4.` },
      { label: "Output proxy", value: `~${estimateTokens(providerResult.output)} tokens`, detail: `${providerResult.output.length} characters / 4.` },
      { label: "Decision source", value: decision.source, detail: decision.explanation ?? decision.decision.reason },
      { label: "Fallback routes", value: String(decision.decision.fallback_routes?.length ?? 0), detail: "Alternatives supplied by the policy decision." }
    ],
    pipelineNodes,
    pipelineEdges,
    steps,
    warnings: [
      ...decision.warnings,
      ...(live ? [] : ["The Lab experiment did not reach a live provider. Add provider keys in Settings or start Ollama."])
    ]
  };
  await appendAudit(live ? "info" : "warning", "lab.experiment", `Lab experiment completed in ${result.mode} mode.`, {
    provider: selectedProvider,
    model: selectedModel,
    prompt_sha256: sha256(experimentPrompt)
  });
  return result;
}

// ---------------------------------------------------------------------------
// Routines (docs/FABLE_PLANS.md section 12) — a routine is a saved prompt that
// runs automatically on a schedule, with results landing in a dedicated
// conversation per routine. A single setTimeout chain drives the scheduler;
// it recomputes the soonest due routine after every fire (or store change) so
// there is never more than one timer live at once, and sleeps are capped at
// 60s slices so the chain self-corrects across system sleep/clock drift
// instead of trusting one long-lived timer to fire at the right wall-clock
// moment.
let routineTimer: ReturnType<typeof setTimeout> | undefined;
let routineTickRunning = false;

async function readRoutines(): Promise<Routine[]> {
  return readStoreValue<Routine[]>("routines", []);
}

async function writeRoutines(routines: Routine[]): Promise<void> {
  await writeStoreValue("routines", routines);
}

function startOfMinute(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

/** Computes the next fire time for a routine's schedule, relative to `from`.
 *  interval: lastRunAt (or now) + N minutes. daily/weekly: the next occurrence
 *  of the given wall-clock time, rolling forward a day/week if it has already
 *  passed today/this-week. Weekday 0 = Sunday (JS convention). */
function computeNextRunAt(routine: Routine, from: Date = new Date()): string {
  const schedule = routine.schedule;
  if (schedule.kind === "interval") {
    const base = routine.lastRunAt ? new Date(routine.lastRunAt) : from;
    const next = new Date(base.getTime() + Math.max(1, schedule.everyMinutes) * 60_000);
    return next < from ? new Date(from.getTime() + Math.max(1, schedule.everyMinutes) * 60_000).toISOString() : next.toISOString();
  }
  if (schedule.kind === "daily") {
    const next = startOfMinute(from);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  // weekly
  const next = startOfMinute(from);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  let dayDelta = schedule.weekday - next.getDay();
  if (dayDelta < 0) dayDelta += 7;
  next.setDate(next.getDate() + dayDelta);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

async function listRoutines(): Promise<Routine[]> {
  return readRoutines();
}

async function saveRoutine(input: Routine): Promise<Routine> {
  const current = await readRoutines();
  const existingIndex = current.findIndex((routine) => routine.id === input.id);
  const base: Routine =
    existingIndex >= 0
      ? { ...current[existingIndex], ...input }
      : { ...input, id: input.id || randomUUID(), createdAt: input.createdAt || new Date().toISOString() };
  const saved: Routine = { ...base, nextRunAt: base.enabled ? computeNextRunAt(base) : undefined };
  const next = existingIndex >= 0 ? current.map((routine, index) => (index === existingIndex ? saved : routine)) : [saved, ...current];
  await writeRoutines(next);
  await appendAudit("info", "routine.save", `Saved routine "${saved.name}".`, { id: saved.id, enabled: saved.enabled });
  scheduleNextRoutineTick();
  return saved;
}

async function deleteRoutine(id: string): Promise<Routine[]> {
  const current = await readRoutines();
  const routine = current.find((item) => item.id === id);
  const next = current.filter((item) => item.id !== id);
  await writeRoutines(next);
  if (routine) {
    await appendAudit("info", "routine.delete", `Deleted routine "${routine.name}".`, { id });
  }
  scheduleNextRoutineTick();
  return next;
}

/** Fires one routine: runs its prompt through the normal session pipeline
 *  (no streaming — routines execute unattended) and persists the result back
 *  onto the routine (lastRunAt/lastRunStatus/conversationId/nextRunAt). Any
 *  failure is caught so one bad routine can never wedge the scheduler chain. */
async function fireRoutine(id: string): Promise<Routine | undefined> {
  const current = await readRoutines();
  const routine = current.find((item) => item.id === id);
  if (!routine) return undefined;

  await appendAudit("info", "routine.fire", `Firing routine "${routine.name}".`, { id: routine.id });

  const now = new Date().toISOString();
  let updated: Routine;
  try {
    const run = await runSession({
      prompt: routine.prompt,
      conversationId: routine.conversationId,
      projectPath: routine.projectPath,
      preset: routine.preset,
      rawPromptStorage: "local-only"
    });
    updated = {
      ...routine,
      lastRunAt: now,
      lastRunStatus: "ok",
      lastRunError: undefined,
      conversationId: run.conversationId ?? routine.conversationId
    };
    await appendAudit("info", "routine.complete", `Routine "${routine.name}" completed.`, {
      id: routine.id,
      conversationId: updated.conversationId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updated = {
      ...routine,
      lastRunAt: now,
      lastRunStatus: "error",
      lastRunError: message
    };
    await appendAudit("error", "routine.error", `Routine "${routine.name}" failed.`, {
      id: routine.id,
      error: message
    });
  }
  updated.nextRunAt = updated.enabled ? computeNextRunAt(updated, new Date(now)) : undefined;

  const afterFire = await readRoutines();
  const next = afterFire.map((item) => (item.id === updated.id ? updated : item));
  await writeRoutines(next);
  return updated;
}

async function runRoutineNow(id: string): Promise<Routine | undefined> {
  const result = await fireRoutine(id);
  scheduleNextRoutineTick();
  return result;
}

/** The scheduler chain: finds the soonest enabled routine, sleeps until it is
 *  due (capped at 60s slices so a laptop sleep/wake or clock change is
 *  re-evaluated at least once a minute instead of oversleeping), fires every
 *  routine that is now due, then recomputes and reschedules itself. */
function scheduleNextRoutineTick(): void {
  if (routineTimer) {
    clearTimeout(routineTimer);
    routineTimer = undefined;
  }
  routineTimer = setTimeout(() => {
    void runRoutineTick();
  }, 60_000);
}

async function runRoutineTick(): Promise<void> {
  if (routineTickRunning) return;
  routineTickRunning = true;
  try {
    const routines = await readRoutines();
    const now = new Date();
    const due = routines.filter((routine) => routine.enabled && routine.nextRunAt && new Date(routine.nextRunAt) <= now);
    for (const routine of due) {
      await fireRoutine(routine.id);
    }
  } finally {
    routineTickRunning = false;
    scheduleNextRoutineTick();
  }
}

/** Called once on app.whenReady: recomputes nextRunAt for any routine missing
 *  it (e.g. created before the app last closed), fires any enabled routine
 *  whose nextRunAt is already in the past and opted into runOnLaunchIfMissed,
 *  then starts the recurring tick chain. */
async function startRoutineScheduler(): Promise<void> {
  const routines = await readRoutines();
  const now = new Date();
  let mutated = false;
  const withNextRun = routines.map((routine) => {
    if (routine.enabled && !routine.nextRunAt) {
      mutated = true;
      return { ...routine, nextRunAt: computeNextRunAt(routine, now) };
    }
    return routine;
  });
  if (mutated) await writeRoutines(withNextRun);

  const missed = withNextRun.filter(
    (routine) => routine.enabled && routine.runOnLaunchIfMissed && routine.nextRunAt && new Date(routine.nextRunAt) <= now
  );
  for (const routine of missed) {
    await fireRoutine(routine.id);
  }
  scheduleNextRoutineTick();
}

// --- Gallery visual RAG (docs/FABLE_PLANS.md section 4) ---
// Local shape mirroring the renderer's GalleryBoard/GalleryImage (src/renderer/ui/App.tsx),
// stored under the generic "galleryBoards" store key — kept local since main.ts must not
// import from renderer/ui.
type StoredGalleryImage = { id: string; src: string; title: string; tags: string[]; analysis: string };
type StoredGalleryBoard = { id: string; title: string; description: string; coverImage: string; images: StoredGalleryImage[]; tags: string[]; linkedSkill: boolean };
type StoredStyleCardPatch = { title?: string; caption?: string; moodTags?: string[] };

const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** Vision-capable Ollama model name families, in the owner's priority order
 *  (gemma preferred; see docs/FABLE_PLANS.md sections 4 and 17). Matched
 *  case-insensitively against installed model names/families. */
const VISION_MODEL_PRIORITY = ["gemma", "qwen-vl", "qwen2-vl", "qwen2.5vl", "llama3.2-vision", "llava", "bakllava", "minicpm-v", "moondream"];

let cachedVisionModel: string | null | undefined; // undefined = not yet detected this run

/** Resolves the vision model to use for gallery captioning/analysis, honoring
 *  the owner's `visionModel` app-store override (renderer-set picker) when
 *  present, and otherwise falling back to the existing auto-detect. If a
 *  configured value is set but Ollama's `/api/tags` is reachable and doesn't
 *  list it, the override is treated as stale (e.g. the model was removed) and
 *  we fall back to auto-detect rather than hard-failing the analyze — the
 *  store read itself is also guarded so a malformed/missing value can never
 *  break analysis. */
async function resolveConfiguredVisionModel(): Promise<string | null> {
  let configured = "";
  try {
    configured = (await readStoreValue<string>("visionModel", "")).trim();
  } catch {
    configured = "";
  }
  if (!configured) {
    return detectOllamaVisionModel();
  }
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (response.ok) {
      const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const installed = (payload.models ?? []).map((entry) => entry.name ?? entry.model).filter(Boolean) as string[];
      if (installed.length && !installed.includes(configured)) {
        await appendAudit(
          "warning",
          "gallery.vision",
          `Configured vision model "${configured}" isn't installed in Ollama; falling back to auto-detect.`,
          { configured }
        );
        return detectOllamaVisionModel();
      }
    }
  } catch {
    // Ollama /api/tags unreachable or returned something unexpected — trust the
    // configured value as-is (it may be a cloud vision model, not a local tag).
  }
  return configured;
}

/** Detects an installed Ollama vision-capable model by scanning `/api/tags`,
 *  cached per app run. Never downloads anything. Returns null on any failure
 *  or when no vision-capable family is installed (fail soft). */
async function detectOllamaVisionModel(): Promise<string | null> {
  if (cachedVisionModel !== undefined) return cachedVisionModel;
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      cachedVisionModel = null;
      return null;
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string; details?: { family?: string; families?: string[] } }> };
    const models = payload.models ?? [];
    for (const family of VISION_MODEL_PRIORITY) {
      const match = models.find((entry) => {
        const haystack = [entry.name, entry.model, entry.details?.family, ...(entry.details?.families ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(family);
      });
      if (match) {
        cachedVisionModel = match.name ?? match.model ?? null;
        return cachedVisionModel;
      }
    }
    cachedVisionModel = null;
    return null;
  } catch {
    cachedVisionModel = null;
    return null;
  }
}

/** Lists installed Ollama models via `/api/tags`. Never throws — any failure
 *  (Ollama not running, network error, bad JSON) is reported as unreachable
 *  rather than propagated (docs/FABLE_PLANS.md §17/§18). */
async function listOllamaModels(): Promise<OllamaListResult> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return { reachable: false, installed: [] };
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const installed = (payload.models ?? []).map((entry) => entry.name).filter((name): name is string => Boolean(name));
    return { reachable: true, installed };
  } catch {
    return { reachable: false, installed: [] };
  }
}

/** Pulls (installs) an Ollama model, streaming NDJSON progress lines from
 *  `/api/pull` back to the renderer via `metis-ollama:pull-progress`. Buffers
 *  partial lines across chunk boundaries since a chunk may split a JSON
 *  object mid-line. Never throws out of this function — all failure paths
 *  emit a terminal `{ done: true, error }` event and resolve with `{ ok: false }`
 *  (docs/FABLE_PLANS.md §17/§18). */
async function pullOllamaModel(
  modelName: string,
  emitProgress: (progress: OllamaPullProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true })
    });
    if (!response.ok || !response.body) {
      const error = `Ollama pull request failed (${response.status})`;
      emitProgress({ model: modelName, status: "error", done: true, error });
      return { ok: false, error };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): { stop: boolean; error?: string } => {
      const trimmed = line.trim();
      if (!trimmed) return { stop: false };
      let parsed: { status?: string; completed?: number; total?: number; error?: string };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { stop: false };
      }
      if (parsed.error) {
        emitProgress({ model: modelName, status: "error", done: true, error: parsed.error });
        return { stop: true, error: parsed.error };
      }
      emitProgress({
        model: modelName,
        status: parsed.status ?? "",
        completed: parsed.completed,
        total: parsed.total,
        done: false
      });
      return { stop: false };
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const result = handleLine(line);
        if (result.stop) return { ok: false, error: result.error };
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) {
      const result = handleLine(buffer);
      if (result.stop) return { ok: false, error: result.error };
    }

    emitProgress({ model: modelName, status: "success", done: true });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitProgress({ model: modelName, status: "error", done: true, error: message });
    return { ok: false, error: message };
  }
}

// --- Speculative prompt prewarm (docs/DRILL_PLAN.md E1, v0.1) ---
// While the owner is still typing a prompt, the renderer may (once opted in
// via the `prewarmEnabled` store key, default OFF) fire a quiet warmup call
// so the LOCAL Ollama model's prefill/KV-cache is primed before the prompt
// is actually submitted, shaving time-to-first-token off the real run. v0.1
// is INVISIBLE PREFILL ONLY: no speculative answer is generated, nothing is
// shown to the user, and this does not touch conversations, session runs,
// stage/stream events, or disk — it is purely a discarded `/api/generate`
// warmup call against local Ollama. LOCAL ONLY, always: this never talks to
// a cloud provider, even if a non-local model id is passed in — Ollama will
// just 404 for an unknown model and the call fails soft like any other
// failure here.

const PREWARM_MIN_DRAFT_LENGTH = 8;
const PREWARM_DEDUPE_WINDOW_MS = 3000;
const PREWARM_FETCH_TIMEOUT_MS = 10000;

/** Optional context the renderer can pass so the warm/draft is built from the
 *  SAME assembled prompt the real pinned chat run will send (docs/DRILL_PLAN.md
 *  O3). Without it, warming uses the raw draft text, which only keeps the
 *  model resident: the real call sends system+context+prompt, a different
 *  prefix, so Ollama's prompt cache misses and prefill runs in full at send
 *  time. With it, the assembled prefix matches and send-time prefill reduces
 *  to just the characters typed since the last warm. */
type PrewarmContext = { conversationId?: string; projectPath?: string };

/** Rebuilds the pinned-chat session prompt for the prewarm path, mirroring
 *  runSession's pre-invoke assembly (decidePolicy -> overrides -> fastLane ->
 *  snapshot/metis/context/knowledge -> sessionProviderPrompt). MUST stay in
 *  lockstep with the pinned branch of runSession (~7509-7605): any text drift
 *  between the two shifts the shared prefix and silently costs cache hits —
 *  if you change one, change the other. Known accepted divergences (all
 *  small, all documented): uses resolveWritableProjectWorkspace (pure) rather
 *  than resolveActiveProjectWorkspace so a background warm can never trigger
 *  a permission grant; decidePolicy runs without a preset; knowledge
 *  retrieval queries the draft rather than the final prompt (the retrieved
 *  chunks rarely change across the last few keystrokes). Fails soft: null on
 *  any error, and the caller falls back to warming the raw draft. */
async function assembleChatPrewarmPrompt(draft: string, context?: PrewarmContext): Promise<string | null> {
  if (!context) return null;
  try {
    const decision = await decidePolicy({ prompt: draft });
    const previousRun = isAttributionQuestion(draft) ? await previousConversationRun(context.conversationId) : null;
    const routeContext = shouldReusePreviousPipeline(draft) ? await previousConversationTaskType(context.conversationId) : null;
    const effectiveDecision = applySessionRouteOverrides(draft, decision.decision, routeContext);
    // Pinned runs always use the neutral pipeline name (PF5a) — stable prefix.
    const pipelineName = "Direct chat";
    const workspace = await resolveWritableProjectWorkspace(context.projectPath);
    const fastLane = isFastLaneEligible(draft, effectiveDecision);
    const projectSnapshot = !fastLane && workspace ? await buildProjectSnapshot(workspace.path) : undefined;
    const metisFile = await loadProjectMetisFile(workspace?.path ?? context.projectPath);
    const conversationContext = await recentConversationContext(context.conversationId);
    const knowledge = fastLane ? null : await retrieveKnowledgeForPrompt(workspace?.path, draft);
    return sessionProviderPrompt(
      draft,
      effectiveDecision,
      pipelineName,
      previousRun,
      projectSnapshot,
      undefined,
      metisFile,
      conversationContext,
      knowledge?.block,
      !fastLane
    );
  } catch {
    return null;
  }
}

let lastPrewarm: { model: string; hash: string; at: number } | null = null;
// Guards against overlapping requests for the same model while a previous
// warm for it is still in flight (e.g. the owner typed two keystrokes fast
// enough that both requests would otherwise race to Ollama).
const prewarmInFlightModels = new Set<string>();

/** Speculatively warms a LOCAL Ollama model with the in-progress draft
 *  prompt (docs/DRILL_PLAN.md E1 v0.1). OFF by default behind the
 *  `prewarmEnabled` store key — a defense-in-depth check here even though
 *  the renderer is expected to gate this itself before ever invoking the
 *  IPC channel. Fails soft and silent in every case: never throws, never
 *  surfaces an error to the renderer, never creates a conversation or
 *  session-run record, never emits a stage/stream event, and never writes a
 *  file — this must stay a pure fire-and-forget warmup fetch whose response
 *  body is discarded, so toggling `prewarmEnabled` back off leaves zero
 *  trace behind. */
async function prewarmModel(model: string, draft: string, context?: PrewarmContext): Promise<void> {
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  const trimmedDraft = typeof draft === "string" ? draft.trim() : "";
  if (!trimmedModel || trimmedDraft.length < PREWARM_MIN_DRAFT_LENGTH) return;
  try {
    if (!(await readStoreValue<boolean>("prewarmEnabled", false))) return;

    const hash = sha256(`${trimmedModel}\n${trimmedDraft}`);
    const now = Date.now();
    if (lastPrewarm && lastPrewarm.model === trimmedModel && lastPrewarm.hash === hash && now - lastPrewarm.at < PREWARM_DEDUPE_WINDOW_MS) {
      return; // Same model+draft warmed too recently to be worth repeating.
    }
    if (prewarmInFlightModels.has(trimmedModel)) {
      return; // A warm for this model is already in flight.
    }

    prewarmInFlightModels.add(trimmedModel);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PREWARM_FETCH_TIMEOUT_MS);
    try {
      // O3: warm with the SAME assembled prompt the real pinned run will send
      // so Ollama's prompt cache prefix-matches at send time and prefill
      // reduces to the trailing keystrokes. Falls back to the raw draft
      // (model-residency benefit only) when assembly is unavailable.
      const assembled = await assembleChatPrewarmPrompt(trimmedDraft, context);
      await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: trimmedModel,
          prompt: assembled ?? trimmedDraft,
          stream: false,
          keep_alive: "5m",
          options: { num_predict: 1 }
        })
      });
      // Response body intentionally discarded — this call exists only for
      // its side effect inside Ollama (loading the model and prefilling the
      // prompt into its KV cache), never for anything it returns.
      lastPrewarm = { model: trimmedModel, hash, at: Date.now() };
    } finally {
      clearTimeout(timeout);
      prewarmInFlightModels.delete(trimmedModel);
    }
  } catch {
    // Ollama unreachable, model missing, aborted, network error, or any
    // other failure — warming is best-effort only, so stay quiet and never
    // throw out of this function.
  }
}

// --- Speculative draft (docs/DRILL_PLAN.md O2a, v0.1) ---
// A sibling to prewarmModel above, but instead of a discarded num_predict:1
// prefill call, this actually generates a short speculative continuation
// from the in-progress draft prompt and returns it, so the renderer can show
// "here's roughly where this is going" before the owner even submits. Same
// fail-soft, LOCAL-ONLY-Ollama, flag-gated posture as prewarmModel: never
// throws, resolves null on any failure, and only ever talks to
// OLLAMA_BASE_URL (127.0.0.1). Still touches no conversation/session-run
// record, no file, and emits no stage/stream event — the caller decides
// what (if anything) to do with the returned text.

const PREWARM_DRAFT_FETCH_TIMEOUT_MS = 45000; // Generates a full candidate response (up to PREWARM_DRAFT_MAX_TOKENS) — needs far more headroom than the 1-token warm.
const PREWARM_DRAFT_MAX_TOKENS = 768;
const SERVABLE_DRAFT_TTL_MS = 3 * 60 * 1000;

let lastDraft: { model: string; hash: string; at: number } | null = null;
// Deliberately separate from prewarmInFlightModels: a warm and a draft for
// the same model must be able to run concurrently without either blocking
// (starving) the other.
const draftInFlightModels = new Set<string>();

/** Oracle v0.3 (DRILL_PLAN O4): the most recent COMPLETE speculative draft,
 *  keyed by the sha256 of the exact prompt string it was generated from.
 *  When a pinned chat run assembles a session prompt whose hash matches, the
 *  draft IS a legitimate sample of the model's answer to that exact prompt
 *  (same model, same default sampling as the real streaming call), so it can
 *  be served instantly instead of re-generating. Only drafts that finished
 *  naturally (done_reason "stop", not the num_predict cap) are servable, and
 *  each is served at most once (one-shot) within a short TTL. */
let servableDraft: { model: string; promptHash: string; text: string; thoughts?: string; at: number } | null = null;

/** One-shot claim of a cached servable draft for an exact (model, prompt
 *  hash) match. Clears the cache on claim so a stale draft can never be
 *  served twice, and expires quietly after SERVABLE_DRAFT_TTL_MS. */
function takeServableDraft(model: string, promptHash: string): { text: string; thoughts?: string } | null {
  if (!servableDraft) return null;
  if (Date.now() - servableDraft.at > SERVABLE_DRAFT_TTL_MS) {
    servableDraft = null;
    return null;
  }
  if (servableDraft.model !== model || servableDraft.promptHash !== promptHash) return null;
  const claimed = { text: servableDraft.text, thoughts: servableDraft.thoughts };
  servableDraft = null;
  return claimed;
}

/** Speculatively drafts a short continuation from the in-progress prompt
 *  against a LOCAL Ollama model (docs/DRILL_PLAN.md O2a v0.1). Same guard
 *  posture as prewarmModel: OFF by default behind `prewarmEnabled`, fails
 *  soft and silent (resolves null, never throws) on any failure — model
 *  missing, Ollama unreachable, aborted, malformed response, or empty
 *  output. Strips a `<think>...</think>` block via the existing splitter so
 *  a reasoning model's draft text is clean; the stripped thinking is
 *  returned alongside it when present, since the renderer may want to show
 *  what the model is "thinking" while the owner is still typing. */
async function draftModel(model: string, draft: string, context?: PrewarmContext): Promise<{ text: string; thoughts?: string } | null> {
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  const trimmedDraft = typeof draft === "string" ? draft.trim() : "";
  if (!trimmedModel || trimmedDraft.length < PREWARM_MIN_DRAFT_LENGTH) return null;
  try {
    if (!(await readStoreValue<boolean>("prewarmEnabled", false))) return null;

    const hash = sha256(`${trimmedModel}\n${trimmedDraft}`);
    const now = Date.now();
    if (lastDraft && lastDraft.model === trimmedModel && lastDraft.hash === hash && now - lastDraft.at < PREWARM_DEDUPE_WINDOW_MS) {
      return null; // Same model+draft drafted too recently to be worth repeating.
    }
    if (draftInFlightModels.has(trimmedModel)) {
      return null; // A draft for this model is already in flight.
    }

    draftInFlightModels.add(trimmedModel);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PREWARM_DRAFT_FETCH_TIMEOUT_MS);
    try {
      // O3: draft from the assembled prompt too — the guess then sees the
      // same context the real run will (conversation continuity, project
      // snapshot, instructions), which both makes the preview representative
      // and shares the warmed prefix with the eventual real call.
      const assembled = await assembleChatPrewarmPrompt(trimmedDraft, context);
      const sentPrompt = assembled ?? trimmedDraft;
      // O4 (v0.3): default sampling, NO temperature override — the draft must
      // be generated exactly the way the real streaming call generates so a
      // cached draft is a legitimate stand-in answer. num_predict is only a
      // runaway cap; done_reason tells us whether the model finished
      // naturally ("stop", servable) or hit the cap ("length", preview-only).
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: trimmedModel,
          prompt: sentPrompt,
          stream: false,
          keep_alive: "5m",
          options: { num_predict: PREWARM_DRAFT_MAX_TOKENS }
        })
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { response?: string; done_reason?: string };
      lastDraft = { model: trimmedModel, hash, at: Date.now() };
      const raw = typeof payload.response === "string" ? payload.response : "";
      const { output, thoughts } = splitThinkTaggedOutput(raw);
      if (!output) return null;
      // Cache for instant serving only when generated from an ASSEMBLED
      // prompt (raw-draft prompts can never hash-match a real run) and the
      // model finished on its own rather than being truncated by the cap.
      if (assembled && payload.done_reason === "stop") {
        servableDraft = { model: trimmedModel, promptHash: sha256(assembled), text: output, thoughts, at: Date.now() };
      }
      return thoughts ? { text: output, thoughts } : { text: output };
    } finally {
      clearTimeout(timeout);
      draftInFlightModels.delete(trimmedModel);
    }
  } catch {
    // Ollama unreachable, model missing, aborted, malformed JSON, or any
    // other failure — drafting is best-effort only, so stay quiet and never
    // throw out of this function.
    return null;
  }
}

/** Rasterizes a `data:image/svg+xml,...` (URL-encoded, NOT base64) data URL to a PNG
 *  nativeImage via a hidden, off-screen BrowserWindow capture. Electron's `nativeImage`
 *  cannot decode SVG at all (createFromDataURL silently yields an empty image for it),
 *  so this is the only reliable in-process rasterization path (docs/FABLE_PLANS.md
 *  section 23). Returns null on any failure (fail soft — caller falls back to
 *  palette-only or skips captioning). */
async function rasterizeSvgDataUrl(src: string): Promise<ReturnType<typeof nativeImage.createEmpty> | null> {
  let win: BrowserWindow | null = null;
  try {
    const commaIndex = src.indexOf(",");
    const encoded = commaIndex >= 0 ? src.slice(commaIndex + 1) : "";
    const svgMarkup = decodeURIComponent(encoded);
    const widthMatch = svgMarkup.match(/width="(\d+)"/);
    const heightMatch = svgMarkup.match(/height="(\d+)"/);
    const width = Math.min(Number(widthMatch?.[1]) || 900, 1024);
    const height = Math.min(Number(heightMatch?.[1]) || 650, 1024);
    win = new BrowserWindow({
      width,
      height,
      show: false,
      webPreferences: { offscreen: true }
    });
    const html = `<!doctype html><html><body style="margin:0;padding:0;">${svgMarkup}</body></html>`;
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    const captured = await win.webContents.capturePage();
    if (captured.isEmpty()) return null;
    return captured;
  } catch {
    return null;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

/** Rasterizes any gallery image source (SVG data URL, raster data URL, or file path)
 *  down to a `nativeImage` bitmap plus PNG base64, resized so the longer edge is
 *  <=1024px. This is the single path both palette extraction AND vision captioning
 *  use, so whatever reaches the model is a real decodable PNG — never raw SVG text
 *  or URL-encoded garbage (docs/FABLE_PLANS.md section 23). Returns null on any
 *  decode failure (fail soft). */
async function decodeImageForPalette(src: string): Promise<{ image: ReturnType<typeof nativeImage.createEmpty>; base64?: string } | null> {
  try {
    let image: ReturnType<typeof nativeImage.createEmpty>;
    const isSvgDataUrl = src.startsWith("data:image/svg+xml");
    if (isSvgDataUrl) {
      const rasterized = await rasterizeSvgDataUrl(src);
      if (!rasterized) return null;
      image = rasterized;
    } else if (src.startsWith("data:")) {
      image = nativeImage.createFromDataURL(src);
    } else {
      const buffer = await readFile(src);
      image = nativeImage.createFromBuffer(buffer);
    }
    if (image.isEmpty()) return null;

    // Resize so the longer edge is <=1024px (vision models choke on huge inputs
    // and it keeps the request payload small), then re-encode as PNG so the
    // base64 handed to Ollama is always a real, decodable raster image.
    const size = image.getSize();
    const longestEdge = Math.max(size.width, size.height);
    const resized = longestEdge > 1024
      ? image.resize(size.width >= size.height ? { width: 1024 } : { height: 1024 })
      : image;
    const base64 = resized.toPNG().toString("base64");
    return { image: resized, base64 };
  } catch {
    return null;
  }
}

/** Median-cut quantization over BGRA pixel bytes (from `nativeImage.toBitmap()`)
 *  down to `count` representative hex colors. Pure JS, no model required. */
function medianCutPalette(bitmap: Buffer, count: number): string[] {
  type Rgb = [number, number, number];
  const pixels: Rgb[] = [];
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    const a = bitmap[i + 3];
    if (a < 16) continue; // skip near-transparent pixels
    pixels.push([r, g, b]);
  }
  if (pixels.length === 0) return [];

  function widestChannel(bucket: Rgb[]): 0 | 1 | 2 {
    let widest: 0 | 1 | 2 = 0;
    let widestRange = -1;
    for (const channel of [0, 1, 2] as const) {
      let min = 255;
      let max = 0;
      for (const p of bucket) {
        if (p[channel] < min) min = p[channel];
        if (p[channel] > max) max = p[channel];
      }
      const range = max - min;
      if (range > widestRange) {
        widestRange = range;
        widest = channel;
      }
    }
    return widest;
  }

  function averageHex(bucket: Rgb[]): string {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of bucket) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = bucket.length;
    const toHex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  let buckets: Rgb[][] = [pixels];
  while (buckets.length < count) {
    let splitIndex = -1;
    let splitSize = -1;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length > splitSize && buckets[i].length > 1) {
        splitSize = buckets[i].length;
        splitIndex = i;
      }
    }
    if (splitIndex === -1) break;
    const bucket = buckets[splitIndex];
    const channel = widestChannel(bucket);
    const sorted = [...bucket].sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(sorted.length / 2);
    const left = sorted.slice(0, mid);
    const right = sorted.slice(mid);
    buckets.splice(splitIndex, 1, left, right);
  }

  return buckets.filter((bucket) => bucket.length > 0).map(averageHex);
}

/** Extracts a 5-color palette from a gallery image src via Electron's
 *  nativeImage + median-cut. Returns [] on any decode failure. */
// Max long edge for the copy of a gallery image persisted on its StyleCard
// (task L9, docs/DRILL_PLAN.md Phase 2): small enough that storing it on every
// card doesn't bloat the JSON store, big enough to still read as a real style
// reference to a vision-capable front-end model.
const STYLE_CARD_IMAGE_MAX_EDGE = 768;

/** Downscales an already-decoded nativeImage to <=STYLE_CARD_IMAGE_MAX_EDGE on
 *  its long edge and encodes it as JPEG base64 for persistence on a StyleCard.
 *  Fails soft to undefined — a card missing this field just contributes
 *  text-only at retrieval time, same as before this existed. */
function downscaleForStyleCardStorage(image: ReturnType<typeof nativeImage.createEmpty>): { imageBase64: string; imageMime: string } | undefined {
  try {
    const size = image.getSize();
    if (size.width === 0 || size.height === 0) return undefined;
    const longestEdge = Math.max(size.width, size.height);
    const resized = longestEdge > STYLE_CARD_IMAGE_MAX_EDGE
      ? image.resize(size.width >= size.height ? { width: STYLE_CARD_IMAGE_MAX_EDGE } : { height: STYLE_CARD_IMAGE_MAX_EDGE })
      : image;
    const imageBase64 = resized.toJPEG(72).toString("base64");
    if (!imageBase64) return undefined;
    return { imageBase64, imageMime: "image/jpeg" };
  } catch {
    return undefined;
  }
}

async function extractPaletteFromImage(src: string): Promise<{ palette: string[]; base64?: string; storageImage?: { imageBase64: string; imageMime: string } }> {
  const decoded = await decodeImageForPalette(src);
  if (!decoded) return { palette: [] };
  const storageImage = downscaleForStyleCardStorage(decoded.image);
  try {
    const resized = decoded.image.resize({ width: 64 });
    const bitmap = resized.toBitmap();
    const palette = medianCutPalette(bitmap, 5);
    return { palette, base64: decoded.base64, storageImage };
  } catch {
    return { palette: [], base64: decoded.base64, storageImage };
  }
}

/** Defensively parses a vision-model response for a JSON `{caption, tags}`
 *  blob, regexing it out of surrounding prose; falls back to using the raw
 *  text as the caption with no tags when no JSON is found. */
function parseCaptionResponse(raw: string): { caption: string; moodTags: string[] } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { caption?: string; tags?: unknown; moodTags?: unknown };
      const rawTags = parsed.tags ?? parsed.moodTags;
      const tags = Array.isArray(rawTags)
        ? rawTags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase().trim()).filter(Boolean).slice(0, 6)
        : [];
      const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
      if (caption) return { caption, moodTags: tags };
    } catch {
      // fall through to plain-text handling
    }
  }
  const plain = raw.replace(/\{[\s\S]*\}/, "").trim();
  return { caption: plain.slice(0, 240), moodTags: [] };
}

const VISION_CAPTION_PROMPT =
  "This image is a design/style reference on a moodboard used by a frontend designer. Write a SPECIFIC, " +
  "evocative style read they could act on as a design brief — not a description of what's literally in the " +
  "picture. In 1-2 tight sentences, name the concrete palette feel (exact hues/contrast, not just 'colorful'), " +
  "the mood, the era or genre it evokes, the typography character if any text or type-like shapes are visible, " +
  "and the composition/density (tight and busy, airy and minimal, grid-like, etc). Never start with filler like " +
  "'this image shows' or 'this is a picture of' — open directly with the style read itself. " +
  "Respond with ONLY a JSON object, no other text: " +
  '{"caption": "your 1-2 sentence style read", "tags": ["3 to 6 lowercase mood or style tags"]}.';

/** Detects the "I can't see an image" refusal family some vision models emit when the
 *  image payload didn't actually reach them (the root cause of docs/FABLE_PLANS.md
 *  section 23 — SVG data URLs previously being base64'd as raw URL-encoded text). A
 *  caption matching this must NEVER be stored — it isn't a real caption. */
function looksLikeMissingImageRefusal(text: string): boolean {
  return /provide the image|cannot see|no (visual|image) input|unable to view/i.test(text);
}

/** Calls Ollama's `/api/generate`, which expects top-level `images: [<base64>]`. */
async function captionViaGenerateEndpoint(model: string, base64: string): Promise<string | null> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: VISION_CAPTION_PROMPT,
      images: [base64],
      stream: false
    })
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { response?: string };
  return payload.response ?? "";
}

/** Calls Ollama's `/api/chat`, which expects the image attached to the message via
 *  `messages: [{ role, content, images: [<base64>] }]` rather than a top-level field.
 *  Used as the retry shape when `/api/generate` yields a "no image" refusal. */
async function captionViaChatEndpoint(model: string, base64: string): Promise<string | null> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: VISION_CAPTION_PROMPT, images: [base64] }],
      stream: false
    })
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { message?: { content?: string } };
  return payload.message?.content ?? "";
}

/** Captions an image via the local Ollama vision model. Tries `/api/generate` first;
 *  if the response is empty OR matches the "I can't see an image" refusal family
 *  (meaning the image didn't really reach the model), retries ONCE via `/api/chat`'s
 *  message-attached image shape. If both fail or both come back as refusals, returns
 *  null so the caller falls back to a palette-only card — a refusal string must never
 *  be stored as a caption (docs/FABLE_PLANS.md section 23). */
async function captionImageWithVisionModel(model: string, base64: string): Promise<{ caption: string; moodTags: string[] } | null> {
  try {
    const first = await captionViaGenerateEndpoint(model, base64);
    if (first && first.trim() && !looksLikeMissingImageRefusal(first)) {
      return parseCaptionResponse(first);
    }
    const retry = await captionViaChatEndpoint(model, base64);
    if (retry && retry.trim() && !looksLikeMissingImageRefusal(retry)) {
      return parseCaptionResponse(retry);
    }
    return null;
  } catch {
    return null;
  }
}

async function readStyleCards(): Promise<Record<string, StyleCard>> {
  return readStoreValue<Record<string, StyleCard>>("styleCards", {});
}

async function writeStyleCards(cards: Record<string, StyleCard>): Promise<void> {
  await writeStoreValue("styleCards", cards);
}

async function readGalleryBoards(): Promise<StoredGalleryBoard[]> {
  return readStoreValue<StoredGalleryBoard[]>("galleryBoards", []);
}

/** Generates a style card for one gallery image: palette always via
 *  median-cut, caption+tags additionally when a local vision model is
 *  installed. Fails soft to a palette-only (or fully empty) card. */
async function generateStyleCard(image: StoredGalleryImage, boardId: string): Promise<StyleCard> {
  const { palette, base64, storageImage } = await extractPaletteFromImage(image.src);
  const visionModel = await resolveConfiguredVisionModel();
  if (visionModel && base64) {
    const captioned = await captionImageWithVisionModel(visionModel, base64);
    if (captioned) {
      return {
        imageId: image.id,
        boardId,
        caption: captioned.caption,
        moodTags: captioned.moodTags,
        palette,
        source: "vision-model",
        model: visionModel,
        createdAt: new Date().toISOString(),
        imageBase64: storageImage?.imageBase64,
        imageMime: storageImage?.imageMime
      };
    }
  }
  return {
    imageId: image.id,
    boardId,
    caption: "",
    moodTags: [],
    palette,
    source: "palette-only",
    createdAt: new Date().toISOString(),
    imageBase64: storageImage?.imageBase64,
    imageMime: storageImage?.imageMime
  };
}

/** Generates cards for every image on a board that doesn't have one yet,
 *  SEQUENTIALLY so the local Ollama server isn't hammered with concurrent
 *  vision requests. Returns all cards (existing + newly generated) for the board. */
async function analyzeGalleryBoard(boardId: string): Promise<StyleCard[]> {
  const boards = await readGalleryBoards();
  const board = boards.find((entry) => entry.id === boardId);
  if (!board) return [];
  const cards = await readStyleCards();
  let mutated = false;
  for (const image of board.images) {
    if (cards[image.id]) continue;
    cards[image.id] = await generateStyleCard(image, boardId);
    mutated = true;
  }
  if (mutated) await writeStyleCards(cards);
  return board.images.map((image) => cards[image.id]).filter((card): card is StyleCard => Boolean(card));
}

async function listStyleCards(): Promise<StyleCard[]> {
  return Object.values(await readStyleCards());
}

// Hard cap on how many URLs a single import call will attempt — keeps a
// pasted list (or a Pinterest board's worth of scraped links) from turning
// into an unbounded fetch storm.
const IMAGE_IMPORT_MAX_URLS = 20;
// Long-edge cap for imported images, matching the gallery's existing
// downscale-on-ingest behavior (see downscaleForStyleCardStorage).
const IMAGE_IMPORT_MAX_EDGE = 1024;
// Per-fetch timeout so one slow/hanging host can't stall the whole batch.
const IMAGE_IMPORT_FETCH_TIMEOUT_MS = 12000;

/** Fetches one URL and, if it's an image, downscales + re-encodes it to a
 *  JPEG data URL via the same nativeImage pipeline used elsewhere for gallery
 *  images (see decodeImageForPalette / downscaleForStyleCardStorage). Returns
 *  null for anything that isn't a fetchable image — callers treat that as a
 *  skip, never a fatal error. */
async function fetchAndDownscaleImage(url: string): Promise<ImportedImage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_IMPORT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "image/*" } });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    const buffer = Buffer.from(arrayBuffer);
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    const longestEdge = Math.max(size.width, size.height);
    if (longestEdge > IMAGE_IMPORT_MAX_EDGE) {
      image = image.resize(
        size.width >= size.height ? { width: IMAGE_IMPORT_MAX_EDGE } : { height: IMAGE_IMPORT_MAX_EDGE }
      );
    }
    const jpegBase64 = image.toJPEG(82).toString("base64");
    if (!jpegBase64) return null;
    return { src: `data:image/jpeg;base64,${jpegBase64}`, mimeType: "image/jpeg", sourceUrl: url };
  } catch {
    // Network error, abort/timeout, or unsupported/corrupt image bytes — skip, never throw.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Imports a batch of direct image URLs (drag-and-drop-of-links fallback for
 *  the gallery, docs/DRILL_PLAN.md Phase 2 L15). Never throws: per-URL
 *  failures are silently skipped, and non-image links are counted into
 *  `note` rather than treated as errors, since a mixed paste (some image
 *  links, some page links) is the expected common case. */
async function importImagesFromUrls(urls: string[]): Promise<ImageImportResult> {
  try {
    const candidates = Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean))).slice(0, IMAGE_IMPORT_MAX_URLS);
    if (candidates.length === 0) {
      return { ok: false, images: [], error: "No URLs provided." };
    }
    const images: ImportedImage[] = [];
    let skipped = 0;
    for (const url of candidates) {
      const imported = await fetchAndDownscaleImage(url);
      if (imported) images.push(imported);
      else skipped += 1;
    }
    const note = skipped > 0 ? `${skipped} link${skipped === 1 ? "" : "s"} were not usable images and were skipped.` : undefined;
    await appendAudit(images.length > 0 ? "info" : "warning", "gallery.import-urls", `Imported ${images.length} image(s) from ${candidates.length} URL(s).`, {
      requested: candidates.length,
      imported: images.length,
      skipped
    });
    return { ok: images.length > 0, images, note, error: images.length === 0 ? "None of the provided URLs resolved to a usable image." : undefined };
  } catch (error) {
    return { ok: false, images: [], error: error instanceof Error ? error.message : "Image import failed." };
  }
}

/** Best-effort extraction of Pinterest CDN image URLs out of a board page's
 *  raw HTML. Pinterest boards are a JS-rendered SPA — the server-sent HTML
 *  usually does not contain the pin grid at all, so this deliberately does
 *  NOT try to be a real scraper (headless rendering, pagination, auth). It
 *  just regexes for any i.pinimg.com URLs that happen to be present in the
 *  initial payload (e.g. inlined JSON/meta tags) and prefers higher-res
 *  variants when both are found for the same pin. */
function extractPinterestImageUrls(html: string): string[] {
  const matches = html.match(/https:\/\/i\.pinimg\.com\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp)/gi) ?? [];
  const upgraded = matches.map((url) => url.replace(/\/\d+x(?:\d+)?\//, "/736x/"));
  return Array.from(new Set(upgraded));
}

/** Best-effort Pinterest board import (docs/DRILL_PLAN.md Phase 2, L15).
 *  Pinterest has no public unauthenticated API for board contents, and its
 *  board pages are a JavaScript-rendered SPA that a plain HTML fetch mostly
 *  can't see into, plus active anti-scraping/rate-limiting — so this is
 *  explicitly a best-effort attempt that degrades gracefully rather than a
 *  reliable importer. On any failure or empty result it returns a clear
 *  `ok: false` with guidance to use the URL-list import instead. Never throws. */
async function importFromPinterestBoard(boardUrl: string): Promise<ImageImportResult> {
  const fallbackNote = "Pinterest blocks scraping; paste direct image URLs or drag images in instead.";
  try {
    const trimmed = boardUrl.trim();
    if (!trimmed) return { ok: false, images: [], error: "No board URL provided.", note: fallbackNote };
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, images: [], error: "That doesn't look like a valid URL.", note: fallbackNote };
    }
    if (!/(^|\.)pinterest\.[a-z.]+$/i.test(parsed.hostname)) {
      return { ok: false, images: [], error: "That doesn't look like a Pinterest URL.", note: fallbackNote };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_IMPORT_FETCH_TIMEOUT_MS);
    let html = "";
    try {
      const response = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; MetisOrchestrator/1.0)" }
      });
      if (response.ok) html = await response.text();
    } catch {
      html = "";
    } finally {
      clearTimeout(timeout);
    }
    const imageUrls = html ? extractPinterestImageUrls(html) : [];
    if (imageUrls.length === 0) {
      await appendAudit("warning", "gallery.import-pinterest", "Pinterest board import found no images (expected — SPA + anti-scraping).", { boardUrl: trimmed });
      return { ok: false, images: [], error: "Pinterest did not return images", note: fallbackNote };
    }
    const result = await importImagesFromUrls(imageUrls);
    if (result.images.length === 0) {
      return { ok: false, images: [], error: "Pinterest did not return images", note: fallbackNote };
    }
    await appendAudit("info", "gallery.import-pinterest", `Imported ${result.images.length} image(s) from a Pinterest board (best effort).`, {
      boardUrl: trimmed,
      imported: result.images.length
    });
    return { ok: true, images: result.images, note: result.note };
  } catch (error) {
    return { ok: false, images: [], error: error instanceof Error ? error.message : "Pinterest import failed.", note: fallbackNote };
  }
}

/** Force-regenerates the style card for one image (docs/FABLE_PLANS.md section 23c) —
 *  unlike analyzeGalleryBoard, this does not skip images that already have a card.
 *  User edits are overwritten by design: reanalysing is an explicit request. */
async function analyzeGalleryImage(boardId: string, imageId: string): Promise<StyleCard | null> {
  const boards = await readGalleryBoards();
  const board = boards.find((entry) => entry.id === boardId);
  const image = board?.images.find((entry) => entry.id === imageId);
  if (!board || !image) return null;
  const cards = await readStyleCards();
  cards[imageId] = await generateStyleCard(image, boardId);
  await writeStyleCards(cards);
  return cards[imageId];
}

/** Merges a human edit (title/caption/moodTags) into an existing style card and
 *  persists it, marking `userEdited: true` so retrieval scoring favors it over
 *  model captions (docs/FABLE_PLANS.md section 23). If no card exists yet for the
 *  image (e.g. the board was never analyzed), synthesizes a minimal palette-less
 *  one from the edit so the human description isn't lost. Returns the updated card. */
async function updateStyleCard(imageId: string, boardId: string, patch: StoredStyleCardPatch): Promise<StyleCard> {
  const cards = await readStyleCards();
  const existing = cards[imageId];
  const next: StyleCard = {
    imageId,
    boardId: existing?.boardId ?? boardId,
    title: patch.title !== undefined ? patch.title : existing?.title,
    caption: patch.caption !== undefined ? patch.caption : existing?.caption ?? "",
    moodTags: patch.moodTags !== undefined ? patch.moodTags : existing?.moodTags ?? [],
    palette: existing?.palette ?? [],
    source: existing?.source ?? "palette-only",
    model: existing?.model,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    userEdited: true,
    imageBase64: existing?.imageBase64,
    imageMime: existing?.imageMime
  };
  cards[imageId] = next;
  await writeStyleCards(cards);
  return next;
}

/** Deletes a style card (e.g. when its image is removed from a board via the
 *  gallery delete-image action). No-op if no card exists for the imageId. */
async function deleteStyleCard(imageId: string): Promise<void> {
  const cards = await readStyleCards();
  if (!(imageId in cards)) return;
  delete cards[imageId];
  await writeStyleCards(cards);
}

/** Scores a style card against the plan output + user prompt via lowercase
 *  token overlap on title+caption+moodTags. Score 0 means "ignore" (no signal).
 *  User-edited cards get a modest flat boost so human descriptions outrank
 *  model captions in retrieval (docs/FABLE_PLANS.md section 23). */
const USER_EDITED_SCORE_BOOST = 2;

function scoreStyleCard(card: StyleCard, tokens: Set<string>): number {
  const cardText = `${card.title ?? ""} ${card.caption} ${card.moodTags.join(" ")}`.toLowerCase();
  const cardTokens = cardText.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const token of cardTokens) {
    if (tokens.has(token)) score++;
  }
  if (score > 0 && card.userEdited) score += USER_EDITED_SCORE_BOOST;
  return score;
}

function promptTokenSet(...texts: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token && token.length > 2) tokens.add(token);
    }
  }
  return tokens;
}

/** Retrieves the best-matching style card for a build, if any (docs/FABLE_PLANS.md
 *  section 4 — "the payoff"). Fails soft: no cards, no match, or any error
 *  yields null and the caller proceeds without a style reference. */
async function retrieveBestStyleCard(planOutput: string, userPrompt: string): Promise<StyleCard | null> {
  try {
    const cards = await listStyleCards();
    if (cards.length === 0) return null;
    const tokens = promptTokenSet(planOutput, userPrompt);
    if (tokens.size === 0) return null;
    let best: StyleCard | null = null;
    let bestScore = 0;
    for (const card of cards) {
      const score = scoreStyleCard(card, tokens);
      if (score > bestScore) {
        bestScore = score;
        best = card;
      }
    }
    return bestScore > 0 ? best : null;
  } catch {
    return null;
  }
}

/** Resolves the app icon (the Metis logo) for the window and taskbar. Packaged
 *  builds read it from resources/ (shipped via electron-builder extraResources);
 *  in dev it comes from build/icon.png at the repo root. electron-builder also
 *  bakes the same icon into the installer and exe. Returns undefined if neither
 *  path exists so the window still opens with the default icon. */
function resolveAppIcon(): string | undefined {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(__dirname, "../../build/icon.png");
  return existsSync(candidate) ? candidate : undefined;
}

async function createWindow(): Promise<void> {
  const appIcon = resolveAppIcon();
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "Metis Orchestrator",
    backgroundColor: "#1b1b1b",
    frame: false,
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  ipcMain.handle("metis-policy:get-sample-decision", () => sampleDecision);
  ipcMain.handle("metis-policy:get-status", (_event, profilePath?: string) => getPolicyStatus(profilePath));
  ipcMain.handle("metis-policy:decide", (_event, input: PolicyDecisionInput) => decidePolicy(input));
  ipcMain.handle("metis-session:run", (_event, input: SessionRunInput) => runSession(input));
  ipcMain.handle("metis-session:run-stream", async (event, streamId: string, input: SessionRunInput) => {
    const emit = (payload: SessionStreamEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("metis-session:stream-event", streamId, payload);
      }
    };
    try {
      const run = await runSession(input, { emit });
      return run;
    } catch (error) {
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
  ipcMain.handle("metis-session:list", () => readSessionRuns());
  ipcMain.on("metis-session:cancel", (_event, projectPath?: string) => requestSessionCancel(projectPath));
  ipcMain.handle(
    "metis-bus:post",
    (
      _event,
      input: { projectPath?: string; conversationId?: string; text: string; kind?: SessionDirective["kind"]; fromAgent?: string; toAgent?: string }
    ) => postSessionDirective(input)
  );
  ipcMain.handle("metis-bus:list", (_event, projectPath?: string) => listSessionDirectives(projectPath));
  ipcMain.handle("metis-conversations:list", () => readConversations());
  ipcMain.handle("metis-conversations:create", (_event, projectPath?: string, firstPrompt?: string) => createConversation(projectPath, firstPrompt));
  ipcMain.handle("metis-conversations:delete", (_event, id: string) => deleteConversation(id));
  ipcMain.handle("metis-conversations:delete-project", (_event, projectPath?: string) => deleteProjectConversations(projectPath));
  ipcMain.handle("metis-conversations:rename", (_event, id: string, title: string) => renameConversation(id, title));
  ipcMain.handle("metis-conversations:archive", (_event, id: string, archived: boolean) => archiveConversation(id, archived));
  ipcMain.handle("metis-conversations:export", (_event, input?: { conversationId?: string }) => exportConversationsMarkdown(input?.conversationId));
  ipcMain.handle("metis-knowledge:searchConversations", (_event, query: string, topK?: number) => retrieveConversationContext(query, topK));
  ipcMain.handle("metis-lab:run-experiment", (_event, prompt?: string) => runLabExperiment(prompt));
  ipcMain.handle("metis-profile:get", () => readUserProfile());
  ipcMain.handle("metis-profile:set", (_e, patch: Partial<UserProfile>) => writeUserProfile(patch));
  ipcMain.handle("metis-project:get-workspace", () => readProjectWorkspace());
  ipcMain.handle("metis-project:snapshot", () => snapshotCurrentProject());
  ipcMain.handle("metis-project:select-folder", () => selectProjectWorkspace());
  ipcMain.handle("metis-project:clear-workspace", () => clearProjectWorkspace());
  ipcMain.handle("metis-project:list-resources", () => listProjectResources());
  ipcMain.handle("metis-project:add-files", () => addProjectResource("file"));
  ipcMain.handle("metis-project:add-folder", () => addProjectResource("folder"));
  ipcMain.handle("metis-project:remove-resource", (_event, id: string) => removeProjectResource(id));
  ipcMain.handle("metis-files:read", (_event, path: string) => readMetisFile(path));
  ipcMain.handle("metis-files:write", (_event, path: string, content: string) => writeMetisFile(path, content));
  ipcMain.on("metis-window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on("metis-window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("metis-window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("metis-shell:open-external", async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle("metis-shell:open-path", async (_event, path: string) => {
    if (!path || /^https?:\/\//i.test(path)) return;
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("metis-store:get", (_event, key: string, fallback: unknown) => readStoreValue(key, fallback));
  ipcMain.handle("metis-store:set", (_event, key: string, value: unknown) => writeStoreValue(key, value));
  ipcMain.handle("metis-secrets:list", () => listSecrets());
  ipcMain.handle("metis-secrets:set", (_event, provider: ProviderKey, value: string) => setSecret(provider, value));
  ipcMain.handle("metis-secrets:delete", (_event, provider: ProviderKey) => deleteSecret(provider));
  ipcMain.handle("metis-permissions:list", () => listPermissions());
  ipcMain.handle("metis-permissions:request", (_event, request: PermissionRequest) => requestPermission(request));
  ipcMain.handle("metis-permissions:revoke", (_event, id: string) => revokePermission(id));
  ipcMain.on("metis-permissions:respond", (_event, id: string, verdict: PermissionVerdict) => respondToPermissionPrompt(id, verdict));
  ipcMain.on("metis-session:answer-question", (_event, id: string, answer: UserQuestionAnswer) => respondToUserQuestion(id, answer));
  ipcMain.handle("metis-audit:list", (_event, limit?: number) => listAudit(limit));
  ipcMain.handle("metis-providers:list", () => listProviders());
  ipcMain.handle("metis-providers:health-check", (_event, provider: ProviderKey) => healthCheckProvider(provider));
  ipcMain.handle("metis-providers:invoke", (_event, input: ProviderInvokeInput) => invokeProvider(input));
  ipcMain.handle("metis-registry:list", () => listRegistry());
  ipcMain.handle("metis-registry:refresh", async (_event, sourceUrl?: string) => {
    const [registry] = await Promise.all([refreshRegistry(sourceUrl), refreshModelCatalog(sourceUrl)]);
    return registry;
  });
  ipcMain.handle("metis-registry:list-installed", () => listInstalledPackages());
  ipcMain.handle("metis-registry:install", (_event, id: string) => installPackage(id));
  ipcMain.handle("metis-registry:uninstall", (_event, id: string) => uninstallPackage(id));
  ipcMain.handle("metis-mcp:probe", async (_event, id: string) => {
    try {
      return await probeMcpServer(id);
    } catch (err) {
      // Extra safety net: probeMcpServer already guards its own paths, but
      // IPC handlers must never throw regardless.
      return { ok: false, error: (err as Error).message } as McpProbeResult;
    }
  });
  ipcMain.handle("metis-catalog:models", () => listModelCatalog());
  ipcMain.handle("metis-pulse:feed", () => listPulseFeed());
  ipcMain.handle("metis-updates:check", () => checkForUpdate());
  ipcMain.handle("metis-ollama:list", () => listOllamaModels());
  ipcMain.handle("metis-ollama:pull", async (event, modelName: string) => {
    return pullOllamaModel(modelName, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("metis-ollama:pull-progress", progress);
      }
    });
  });
  // Speculative prompt prewarm (docs/DRILL_PLAN.md E1 v0.1) — fire-and-forget
  // from the renderer's perspective; prewarmModel resolves to void/undefined
  // in every case (including all its own no-op/fail-soft paths), so there is
  // nothing meaningful to await here beyond letting IPC settle.
  ipcMain.handle("metis-prewarm:warm", (_event, model: string, draft: string, context?: PrewarmContext) => prewarmModel(model, draft, context));
  // Speculative draft (docs/DRILL_PLAN.md O2a v0.1) — sibling to the warm
  // channel above, but resolves to the actual drafted text (or null on any
  // failure/guard) instead of void, so the renderer can choose to show it.
  ipcMain.handle("metis-prewarm:draft", (_event, model: string, draft: string, context?: PrewarmContext) => draftModel(model, draft, context));
  ipcMain.handle("metis-routines:list", () => listRoutines());
  ipcMain.handle("metis-routines:save", (_event, input: Routine) => saveRoutine(input));
  ipcMain.handle("metis-routines:delete", (_event, id: string) => deleteRoutine(id));
  ipcMain.handle("metis-routines:run-now", (_event, id: string) => runRoutineNow(id));
  ipcMain.handle("metis-manager:chat", (_event, history: ManagerChatMessage[]) => runManagerChat(history));
  ipcMain.handle("metis-manager:action", (_event, action: ManagerAction) => executeManagerAction(action));
  ipcMain.handle("metis-gallery:analyze-board", (_event, boardId: string) => analyzeGalleryBoard(boardId));
  ipcMain.handle("metis-gallery:cards", () => listStyleCards());
  ipcMain.handle("metis-gallery:update-card", (_event, imageId: string, boardId: string, patch: StoredStyleCardPatch) => updateStyleCard(imageId, boardId, patch));
  ipcMain.handle("metis-gallery:delete-card", (_event, imageId: string) => deleteStyleCard(imageId));
  ipcMain.handle("metis-gallery:analyze-image", (_event, boardId: string, imageId: string) => analyzeGalleryImage(boardId, imageId));
  ipcMain.handle("metis-gallery:import-urls", (_event, urls: string[]) => importImagesFromUrls(Array.isArray(urls) ? urls : []));
  ipcMain.handle("metis-gallery:import-pinterest", (_event, boardUrl: string) => importFromPinterestBoard(typeof boardUrl === "string" ? boardUrl : ""));
  await createWindow();

  // Warm the live registry, model catalog, and Pulse feed on launch so the
  // cache is fresh; each call caches last-good state for offline use.
  void refreshRegistry();
  void refreshModelCatalog();
  void refreshPulseFeed();
  void startRoutineScheduler();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
