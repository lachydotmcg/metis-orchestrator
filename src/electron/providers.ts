/** Providers: invocation, key pools, cooldowns and secrets.
 *
 *  Fifth carve of docs/STRUCTURAL_DEBT.md item 1, and the largest — 1,116 lines
 *  for **ten** injected dependencies, the best ratio of any of them.
 *
 *  **It was carved as three ranges, not one.** The subsystem is scattered across
 *  `main.ts`: cooldowns and account pooling near the top, secrets and status in
 *  the middle, the actual invocation five hundred lines later. Taking only the
 *  invocation block — the obvious slice, and the one first proposed — measured
 *  at 545 lines needing 21, because ten of those 21 were the rest of its own
 *  subsystem sitting elsewhere in the file. Whole, it needs ten. A module that
 *  injects half of itself is not a module.
 *
 *  Dependencies are injected rather than imported, because importing them would
 *  make `main -> providers -> main`. And nothing here imports electron by name,
 *  which is what lets `34-provider-cooldowns` exercise the rotation and cooldown
 *  arithmetic without a network or an app.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendAudit,
  dataPath,
  readStoreValue,
  writeStoreValue
} from "./store.js";
import {
  ThinkBudgetExceededError,
  shouldPromoteForThinking,
  thinkCeilingChars
} from "../shared/think-budget.js";
import type {
  ModelAccessRoute,
  ProviderAccount,
  ProviderInvokeInput,
  ProviderInvokeResult,
  ProviderKey,
  ProviderStatus,
  SecretStatus,
  SessionStreamEvent
} from "../shared/runtime-contracts.js";

/** Structural twin of main.ts's private `SessionStreamController` — the same
 *  trick cli.ts, gateway.ts and loop-runtime.ts all use. `unattended` is
 *  carried because dropping a field compiles fine and changes behaviour
 *  silently; that has happened once in this refactor already. */
type SessionStreamController = { emit: (event: SessionStreamEvent) => void; unattended?: boolean };

/** The ten things this subsystem still needs from main.ts.
 *
 *  Every one is a generic utility rather than a provider concern — cancellation
 *  plumbing, token estimation, think-tag splitting. That is the sign the seam is
 *  in the right place: what is left is not provider code that stayed behind. */
export interface ProviderDeps {
  cancellationError: (scope?: string) => Error;
  isAbortError: (error: unknown) => boolean;
  registerAbortController: (scope: string) => AbortController;
  unregisterAbortController: (scope: string, controller: AbortController) => void;
  directiveScopeKey: (projectPath?: string) => string;
  emitStream: (stream: SessionStreamController | undefined, event: SessionStreamEvent) => void;
  estimateUsage: (promptChars: number, outputChars: number) => { inputTokens: number; outputTokens: number; estimated: boolean };
  createThinkTagStreamSplitter: (onOutput: (delta: string) => void, onThought: (delta: string) => void) => { feed: (chunk: string) => void; flush: () => void };
  splitThinkTaggedOutput: (value: string) => { output: string; thoughts: string };
  sha256: (value: string) => string;
  /** Electron's OS keychain wrapper. Injected rather than imported for the
   *  reason that governs every carve here: a NAMED import from "electron"
   *  throws at load time in plain node, so importing it would make this whole
   *  module — and its behavioural suite — impossible to load. main.ts keeps the
   *  import; this side only needs three methods off it. */
  safeStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (value: string) => Buffer;
    decryptString: (value: Buffer) => string;
  };
}

/** Provider DATA, moved with the code that reads it.
 *
 *  These were invisible to the dependency measurement, which counts called
 *  identifiers — a constant or a type referenced without parentheses does not
 *  register. The compiler found them; the measurement did not. Noted in
 *  docs/STRUCTURAL_DEBT.md so the next carve expects it. */
export const providerKeyPattern = /^[a-z0-9_-]+$/;

export type StoredSecret = {
  value: string;
  storage: "safeStorage" | "plain-local";
  updatedAt: string;
};

export type StoredSecrets = Partial<Record<ProviderKey, StoredSecret>>;

export const providerInfo: Record<ProviderKey, { label: string; defaultModel?: string }> = {
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-4-6" },
  openai: { label: "OpenAI", defaultModel: "gpt-5.1" },
  gemini: { label: "Google Gemini", defaultModel: "gemini-2.5-pro" },
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-v4-flash" },
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

let injected: ProviderDeps | null = null;

/** Wire the provider subsystem. Called once from main.ts. */
export function configureProviders(deps: ProviderDeps): void {
  injected = deps;
}

function need(): ProviderDeps {
  if (!injected) throw new Error("Providers were used before configureProviders() ran.");
  return injected;
}

/** Error thrown by invokeCloudProvider for HTTP failures; carries the status
 *  code and a parsed Retry-After (seconds) when the response provided one, so
 *  quota-rotation can set an accurate cooldown instead of always defaulting. */
export class ProviderHttpError extends Error {
  status?: number;
  retryAfterSeconds?: number;
  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isQuotaError(error: unknown): error is ProviderHttpError {
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return QUOTA_ERROR_PATTERN.test(message);
}

export function markProviderCooldown(provider: ProviderKey, error: unknown): number {
  const retryAfterSeconds = error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined;
  const durationMs = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_COOLDOWN_MS;
  const until = Date.now() + durationMs;
  providerCooldowns.set(provider, until);
  return until;
}

export function providerCooldownUntil(provider: ProviderKey): number | undefined {
  const until = providerCooldowns.get(provider);
  if (!until) return undefined;
  if (until <= Date.now()) {
    providerCooldowns.delete(provider);
    return undefined;
  }
  return until;
}

export function isProviderCooling(provider: ProviderKey): boolean {
  return providerCooldownUntil(provider) !== undefined;
}

export function formatCooldownDuration(untilMs: number): string {
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

export async function readProviderAccounts(): Promise<ProviderAccount[]> {
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

export function markAccountCooldown(accountId: string, error: unknown): number {
  const retryAfterSeconds = error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined;
  const durationMs = typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : DEFAULT_COOLDOWN_MS;
  const until = Date.now() + durationMs;
  accountCooldowns.set(accountId, until);
  void persistAccountCooldown(accountId, until);
  return until;
}

export function accountCooldownUntil(accountId: string): number | undefined {
  const until = accountCooldowns.get(accountId);
  if (!until) return undefined;
  if (until <= Date.now()) {
    accountCooldowns.delete(accountId);
    return undefined;
  }
  return until;
}

export function isAccountCooling(accountId: string): boolean {
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
export async function recordAccountUsage(account: ProviderAccount | undefined): Promise<void> {
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
export async function effectiveAccountsForProvider(provider: ProviderKey): Promise<ProviderAccount[]> {
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
export function orderAccountsForRotation(accounts: ProviderAccount[]): ProviderAccount[] {
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
export async function syncProviderCooldownFromAccounts(provider: ProviderKey, accounts: ProviderAccount[]): Promise<void> {
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
export async function resolveAccountSecret(account: ProviderAccount): Promise<string | undefined> {
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
export async function isProviderConfigured(provider: ProviderKey): Promise<boolean> {
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
export async function resolveModelRoute(access: ModelAccessRoute[], pinned?: ProviderKey): Promise<ModelAccessRoute | null> {
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

export function validateProvider(provider: string): asserts provider is ProviderKey {
  if (!providerKeyPattern.test(provider) || !(provider in providerInfo)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

export async function readSecrets(): Promise<StoredSecrets> {
  return readStoreValue<StoredSecrets>("secrets", {});
}

export async function writeSecrets(value: StoredSecrets): Promise<void> {
  await writeStoreValue("secrets", value);
}

function encryptSecret(value: string): StoredSecret {
  const updatedAt = new Date().toISOString();
  if (need().safeStorage.isEncryptionAvailable()) {
    return {
      value: need().safeStorage.encryptString(value).toString("base64"),
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
    return need().safeStorage.decryptString(bytes);
  }
  return bytes.toString("utf8");
}

export async function setSecret(provider: ProviderKey, value: string): Promise<SecretStatus> {
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

export function secretStatus(provider: ProviderKey, secrets: StoredSecrets): SecretStatus {
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

export async function listSecrets(): Promise<SecretStatus[]> {
  const secrets = await readSecrets();
  return (Object.keys(providerInfo) as ProviderKey[]).map((provider) => secretStatus(provider, secrets));
}

export async function deleteSecret(provider: ProviderKey): Promise<void> {
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

export async function listProviders(): Promise<ProviderStatus[]> {
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

export async function healthCheckProvider(provider: ProviderKey): Promise<ProviderStatus> {
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

export async function readProviderSecret(provider: ProviderKey): Promise<string | undefined> {
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

/** `scope` is the same cancel-scope key used by cancelledScopes/throwIfCancelled
 *  (need().directiveScopeKey(projectPath)). When present, every fetch this call makes
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
export async function invokeProvider(
  input: ProviderInvokeInput,
  stream?: SessionStreamController,
  scope?: string,
  accountOverride?: ProviderAccount
): Promise<ProviderInvokeResult> {
  validateProvider(input.provider);
  if (input.provider === "ollama") {
    const controller = scope ? need().registerAbortController(scope) : undefined;
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
      const split = need().splitThinkTaggedOutput(payload.response ?? "");
      const combinedThoughts = [fieldThoughts, split.thoughts].filter(Boolean).join("\n\n").trim();
      const audit = await appendAudit("info", "provider.invoke", `Ran ${input.model} through Ollama.`, {
        provider: input.provider,
        model: input.model,
        prompt_sha256: need().sha256(input.prompt)
      });
      const usage =
        typeof payload.prompt_eval_count === "number" && typeof payload.eval_count === "number"
          ? { inputTokens: payload.prompt_eval_count, outputTokens: payload.eval_count }
          : need().estimateUsage(input.prompt.length, split.output.length);
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
      if (need().isAbortError(error)) throw need().cancellationError();
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
      if (scope && controller) need().unregisterAbortController(scope, controller);
    }
  }

  const secret = accountOverride ? await resolveAccountSecret(accountOverride) : await readProviderSecret(input.provider);
  if (!secret) {
    const audit = await appendAudit("warning", "provider.invoke.placeholder", `${providerInfo[input.provider].label} route prepared without a saved API key.`, {
      provider: input.provider,
      model: input.model,
      prompt_sha256: need().sha256(input.prompt)
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

  const cloudController = scope ? need().registerAbortController(scope) : undefined;
  try {
    const { text: output, usage: reportedUsage } = await invokeCloudProvider(input, secret, cloudController?.signal);
    const audit = await appendAudit("info", "provider.invoke", `Ran ${input.model} through ${providerInfo[input.provider].label}.`, {
      provider: input.provider,
      model: input.model,
      prompt_sha256: need().sha256(input.prompt)
    });
    if (accountOverride) await recordAccountUsage(accountOverride);
    return {
      provider: input.provider,
      model: input.model,
      output,
      source: input.provider,
      auditId: audit.id,
      usage: reportedUsage ?? need().estimateUsage(input.prompt.length, output.length)
    };
  } catch (error) {
    if (need().isAbortError(error)) throw need().cancellationError();
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
    if (scope && cloudController) need().unregisterAbortController(scope, cloudController);
  }
}

export async function invokeOllamaProviderStream(input: ProviderInvokeInput, stream: SessionStreamController, signal?: AbortSignal): Promise<ProviderInvokeResult> {
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
  const splitter = need().createThinkTagStreamSplitter(
    (delta) => {
      markFirstToken();
      output += delta;
      need().emitStream(stream, { kind: "message_delta", delta });
    },
    (delta) => {
      markFirstToken();
      thoughts += delta;
      need().emitStream(stream, { kind: "thought_delta", delta });
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
      need().emitStream(stream, { kind: "thought_delta", delta: thoughtField });
    }
    if (payload.response) splitter.feed(payload.response);
    if (typeof payload.prompt_eval_count === "number") promptEvalCount = payload.prompt_eval_count;
    if (typeof payload.eval_count === "number") evalCount = payload.eval_count;
  };
  // The think-token ceiling (docs/COMPETITIVE_SWEEP.md item 3). Checked here
  // rather than after the fact because the whole value is acting BEFORE the
  // answer is paid for: a model that will not stop thinking is telling us the
  // rung was wrong, and that is only useful while it is still talking.
  //
  // Enforced by cancelling the reader rather than by an AbortSignal — the
  // signal belongs to the user's Stop button, and reusing it would make a
  // promotion indistinguishable from a cancellation at every catch site above.
  const thinkCeiling = thinkCeilingChars(input.thinkTokenCeiling ?? 0);
  let overran = false;
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
    if (shouldPromoteForThinking({ thoughtChars: thoughts.length, outputChars: output.length, ceilingChars: thinkCeiling })) {
      overran = true;
      break;
    }
  }
  if (overran) {
    await reader.cancel().catch(() => undefined);
    throw new ThinkBudgetExceededError(thoughts.length);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    handleChunk(JSON.parse(buffer) as OllamaStreamChunk);
  }
  splitter.flush();

  const audit = await appendAudit("info", "provider.invoke", `Streamed ${input.model} through Ollama.`, {
    provider: input.provider,
    model: input.model,
    prompt_sha256: need().sha256(input.prompt)
  });
  const usage =
    typeof promptEvalCount === "number" && typeof evalCount === "number"
      ? { inputTokens: promptEvalCount, outputTokens: evalCount }
      : need().estimateUsage(input.prompt.length, output.length);
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

export async function invokeCloudProvider(input: ProviderInvokeInput, secret: string, signal?: AbortSignal): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> {
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
    // `deepseek-chat` and `deepseek-reasoner` were RETIRED on 2026-07-24 and
    // now 404. DeepSeek's first-party API exposes exactly two ids, both
    // floating aliases with no dated snapshot: deepseek-v4-pro and
    // deepseek-v4-flash. Reasoning stopped being a separate model card and
    // became a request parameter, so the old r1-vs-chat split maps onto the
    // pro/flash pair rather than onto two model names.
    const model = /pro|r1|reason/i.test(input.model) ? "deepseek-v4-pro" : "deepseek-v4-flash";
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

export async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
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
