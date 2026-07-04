import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  ProviderInvokeInput,
  ProviderInvokeResult,
  ProviderKey,
  ProviderStatus,
  DesignSeed,
  MetisFileReadResult,
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
  SecretStatus,
  Routine,
  StyleCard,
  UserQuestionRequest
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

async function listProviders(): Promise<ProviderStatus[]> {
  const secrets = await readSecrets();
  const secretStatuses = await listSecrets();
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
    if (cooldownUntil) {
      return {
        provider,
        label: info.label,
        configured,
        status: "unavailable",
        detail: `Cooling down until ${new Date(cooldownUntil).toLocaleTimeString()} after a quota/rate-limit response.`,
        defaultModel: info.defaultModel
      };
    }
    return {
      provider,
      label: info.label,
      configured,
      status: configured ? "available" : "not_configured",
      detail: configured
        ? secretStatuses.find((status) => status.provider === provider)?.storage === "environment"
          ? "API key available from the launch environment."
          : "API key stored locally."
        : "Add a provider-level API key in Settings.",
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
    const cooldownUntil = providerCooldownUntil(provider);
    if (cooldownUntil) {
      return {
        provider,
        label: info.label,
        configured,
        status: "unavailable",
        detail: `Cooling down until ${new Date(cooldownUntil).toLocaleTimeString()} after a quota/rate-limit response.`,
        defaultModel: info.defaultModel
      };
    }
    return {
      provider,
      label: info.label,
      configured,
      status: configured ? "available" : "not_configured",
      detail: configured ? "Credential is present. Live API call is permission-gated." : "No provider-level API key is saved.",
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
      detail: error instanceof Error ? error.message : "Ollama is not reachable.",
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

async function invokeProvider(input: ProviderInvokeInput, stream?: SessionStreamController): Promise<ProviderInvokeResult> {
  validateProvider(input.provider);
  if (input.provider === "ollama") {
    try {
      if (stream) {
        return await invokeOllamaProviderStream(input, stream);
      }
      const response = await fetch("http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: input.model, prompt: input.prompt, stream: false })
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
      const audit = await appendAudit("warning", "provider.invoke", `Ollama invocation failed for ${input.model}.`, {
        provider: input.provider,
        model: input.model,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        provider: input.provider,
        model: input.model,
        output: "Ollama is not reachable yet, so Metis recorded the route without running the model.",
        source: "placeholder",
        auditId: audit.id
      };
    }
  }

  const secret = await readProviderSecret(input.provider);
  if (!secret) {
    const audit = await appendAudit("warning", "provider.invoke.placeholder", `${providerInfo[input.provider].label} route prepared without a saved API key.`, {
      provider: input.provider,
      model: input.model,
      prompt_sha256: sha256(input.prompt)
    });
    return {
      provider: input.provider,
      model: input.model,
      output: "The selected cloud provider is not configured yet. Add the provider key in Settings, then run this route again.",
      source: "placeholder",
      auditId: audit.id
    };
  }

  try {
    const { text: output, usage: reportedUsage } = await invokeCloudProvider(input, secret);
    const audit = await appendAudit("info", "provider.invoke", `Ran ${input.model} through ${providerInfo[input.provider].label}.`, {
      provider: input.provider,
      model: input.model,
      prompt_sha256: sha256(input.prompt)
    });
    return {
      provider: input.provider,
      model: input.model,
      output,
      source: input.provider,
      auditId: audit.id,
      usage: reportedUsage ?? estimateUsage(input.prompt.length, output.length)
    };
  } catch (error) {
    if (isQuotaError(error)) {
      const until = markProviderCooldown(input.provider, error);
      await appendAudit("warning", "provider.invoke.cooldown", `${providerInfo[input.provider].label} hit a quota/rate limit — cooling down for ${formatCooldownDuration(until)}.`, {
        provider: input.provider,
        model: input.model,
        error: error instanceof Error ? error.message : String(error),
        cooldownUntil: new Date(until).toISOString()
      });
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
  }
}

async function invokeOllamaProviderStream(input: ProviderInvokeInput, stream: SessionStreamController): Promise<ProviderInvokeResult> {
  const response = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: input.model, prompt: input.prompt, stream: true })
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Ollama did not return a readable stream.");

  let output = "";
  let thoughts = "";
  const splitter = createThinkTagStreamSplitter(
    (delta) => {
      output += delta;
      emitStream(stream, { kind: "message_delta", delta });
    },
    (delta) => {
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
    usage
  };
}

async function invokeCloudProvider(input: ProviderInvokeInput, secret: string): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }> {
  if (input.provider === "anthropic") {
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
        messages: [{ role: "user", content: input.prompt }]
      })
    });
    const text = response.content?.map((part) => part.text).filter(Boolean).join("\n").trim() || "Anthropic returned an empty response.";
    const usage =
      typeof response.usage?.input_tokens === "number" && typeof response.usage?.output_tokens === "number"
        ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
        : undefined;
    return { text, usage };
  }

  if (input.provider === "openai") {
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
        input: input.prompt
      })
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
    const response = await fetchJson<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(secret)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: input.prompt }] }]
      })
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
      })
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
      })
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
      })
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
      })
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

/** AskUserQuestion tag scan (docs/FABLE_PLANS.md section 24): looks for
 *  `<ask_user>{"question":"...","options":[...]}</ask_user>` anywhere in a
 *  stage's raw output. Fails soft — malformed JSON just means no question was
 *  detected, so the stage output passes through unchanged. */
function extractAskUserTag(value: string): { question: string; options: string[] } | null {
  const match = /<ask_user>([\s\S]*?)<\/ask_user>/i.exec(value);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as { question?: unknown; options?: unknown };
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
const pendingUserQuestions = new Map<string, (answer: string) => void>();

/** Pauses awaiting a renderer answer to an AskUserQuestion tag; on timeout,
 *  picks the first option (or a generic default) and reports that it did so
 *  via the returned `timedOut` flag so the caller can add a timeline line. */
async function promptUserQuestion(
  stream: SessionStreamController | undefined,
  text: string,
  options: string[]
): Promise<{ answer: string; timedOut: boolean }> {
  const fallbackAnswer = options[0] ?? "(no preference given — use your best judgement)";
  if (!stream) return { answer: fallbackAnswer, timedOut: false };
  const id = randomUUID();
  const question: UserQuestionRequest = { id, text, options };
  emitStream(stream, { kind: "user_question", question });
  return new Promise((resolveAnswer) => {
    const timer = setTimeout(() => {
      pendingUserQuestions.delete(id);
      resolveAnswer({ answer: fallbackAnswer, timedOut: true });
    }, PENDING_QUESTION_TIMEOUT_MS);
    pendingUserQuestions.set(id, (answer) => {
      clearTimeout(timer);
      pendingUserQuestions.delete(id);
      resolveAnswer({ answer, timedOut: false });
    });
  });
}

function respondToUserQuestion(id: string, answer: string): void {
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

async function readProjectWorkspace(): Promise<ProjectWorkspace | null> {
  const workspace = await readStoreValue<ProjectWorkspace | null>("projectWorkspace", null);
  if (!workspace?.path || !workspace.permissionId) return null;
  return {
    ...workspace,
    path: resolve(workspace.path),
    name: workspace.name || basename(workspace.path) || workspace.path
  };
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
async function readMetisFile(rawPath: string): Promise<MetisFileReadResult> {
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

  return { path: target, name: basename(target), content };
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

function snapshotPromptContext(snapshot?: ProjectSnapshot): string {
  if (!snapshot) return "";
  const scripts = snapshot.scripts.length ? snapshot.scripts.join(", ") : "none detected";
  const deps = snapshot.dependencies.length ? snapshot.dependencies.slice(0, 12).join(", ") : "none detected";
  const files = snapshot.files.slice(0, 30).map((file) => `${file.kind === "directory" ? "dir" : "file"}:${file.path}`).join("\n");
  return [
    "Project snapshot:",
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
    await requestPermission({ scope, target: target.name, note: `Requested by package "${target.name}" (${target.id}).` });
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
  await appendAudit("info", "registry.uninstall", `Uninstalled ${id}.`, { id });
  return next;
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
      news: Array.isArray(payload.news) ? (payload.news as PulseFeed["news"]) : []
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
      updated: cached?.updated
    };
    await writeStoreValue("pulseFeed", state);
    return state;
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

function initialPipelineSteps(pipelineName: string, decision: RouteDecision, includeProjectTools = true): SessionPipelineStep[] {
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

function sessionProviderPrompt(prompt: string, decision: RouteDecision, _pipelineName: string, previousRun?: SessionRun | null, projectSnapshot?: ProjectSnapshot, designSeed?: DesignSeed, metisFile?: { content: string; chars: number } | null): string {
  const previousSource = previousRun?.providerResult
    ? `Previous response source: ${providerInfo[previousRun.providerResult.provider].label} / ${previousRun.providerResult.model} via ${previousRun.pipelineName}.`
    : previousRun
      ? `Previous response source: ${previousRun.pipelineName}; no live provider result was recorded.`
      : "";
  return [
    metisFilePromptBlock(metisFile ?? null),
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

function isBuildQuestionGuard(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^\s*(what|which|who|whose|when|where|why|how|did|was|were|is|are|does|do)\b/i.test(trimmed)) return true;
  if (/\?\s*$/.test(trimmed) && /\b(asked|created|built|made|generated|wrote)\b/i.test(trimmed)) return true;
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

  const next = current.map((item) => (item.id === id ? { ...item, title: trimmed } : item));
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

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

type StageModelRef = { provider: ProviderKey; model: string };
// `accessVia` (docs/FABLE_PLANS.md section 25) is the pinned route provider
// for this stage's PRIMARY model only (a graph node's "Access via" override);
// callStageWithFallback/expandChainByRoutes apply it exclusively to chain[0].
// `templateRole` (section 25) decouples the STAGE PROMPT TEMPLATE from the
// stage id: default stages use their own id as the role, but graph-driven
// stages keep the graph node's real id (for audit/result tracking) and pick
// their prompt template by POSITION instead — first stage plans, second
// builds the front end, the rest are functional/support passes.
type StageConfig = { id: string; label: string; chain: StageModelRef[]; accessVia?: ProviderKey; templateRole: "plan" | "frontend" | "functional" };

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
  // Best-effort slug for hand-typed names like "GPT 5.6" -> "gpt-5.6".
  return raw.toLowerCase().replace(/\s+/g, "-");
}

function overrideStageRef(override: SessionModelOverride): StageModelRef {
  return { provider: override.provider, model: resolveOverrideModel(override) };
}

function overrideDisplayLabel(override: SessionModelOverride): string {
  return override.label ?? `${providerInfo[override.provider].label} ${override.model}`;
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
    const accessVia = stage.accessVia && isKnownProvider(stage.accessVia) ? stage.accessVia : undefined;
    return {
      id: stage.id,
      label: stage.label || `Stage ${index + 1}`,
      chain: [primary, ...fallbackRefs, localStageRef()],
      accessVia,
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
  const writable = await resolveWritableProjectWorkspace(input.projectPath);
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

// Gate for the full multi-stage build pipeline. Prefers the router's own
// judgement (decision.task_type) over regex-sniffing the prompt, so a status
// question like "Without generating anything, what's the status of my
// website file?" never fires the pipeline just because it contains "website".
function shouldRunBuildPipeline(prompt: string, decision: RouteDecision, decisionSource: PolicyDecisionResult["source"]): boolean {
  if (isBuildOptOut(prompt)) return false;
  if (isBuildQuestionGuard(prompt)) return false;

  if (decisionSource === "sample") {
    // Offline/sample mode: the router has no real signal, so fall back to the
    // legacy regex behavior (guards above already applied).
    return hasImperativeBuildIntent(prompt);
  }

  if (BUILD_TASK_TYPES.has(decision.task_type)) {
    // Router says this is a build/design task — still require imperative
    // build intent in the prompt as confirmation, not the sole trigger.
    return hasImperativeBuildIntent(prompt);
  }

  return false;
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

/** Default gateways (docs/FABLE_PLANS.md section 25) — a Settings-configured
 *  map of "route models from this HOME provider via this OTHER provider by
 *  default" (e.g. { deepseek: "nvidia" } sends DeepSeek-family models via
 *  NVIDIA NIM unless a node/stage pins something else). Read fresh on every
 *  expansion since Settings can change it mid-session; fails soft to {}. */
async function getDefaultGateways(): Promise<Partial<Record<ProviderKey, ProviderKey>>> {
  return readStoreValue<Partial<Record<ProviderKey, ProviderKey>>>("defaultGateways", {});
}

/** Route-before-model fallback (docs/FABLE_PLANS.md section 21, extended by
 *  section 25's default gateways): given one {provider, model} stage entry,
 *  looks it up in the cached model catalog and, if the catalog knows this
 *  exact provider+model as one of a model's access routes, returns ALL of
 *  that model's routes as StageModelRefs, ordered so a rate-limited NVIDIA
 *  route falls through to the deepseek API route of the SAME model before the
 *  chain ever moves on to a different model. When the ref isn't found in the
 *  catalog (or the catalog is empty), returns the ref unchanged as a
 *  single-entry array — callers always get at least one StageModelRef back.
 *
 *  Pin precedence (section 25): explicit `pinned` (a node's "Access via"
 *  override) > `defaultGateways[model's home provider]` > first
 *  configured-and-not-cooling route > first configured-but-cooling route >
 *  the rest. A pinned/gateway route only jumps the queue when it's actually
 *  configured — an unconfigured pin is silently ignored, same as
 *  resolveModelRoute's behavior. */
async function expandStageRef(ref: StageModelRef, pinned?: ProviderKey): Promise<StageModelRef[]> {
  const catalog = await listModelCatalog();
  const model = catalog.models.find((entry) => (entry.access ?? []).some((route) => route.provider === ref.provider && route.id === ref.model));
  if (!model || !model.access || model.access.length === 0) return [ref];

  const effectivePin = pinned ?? (await getDefaultGateways())[model.provider];

  const configuredFlags = await Promise.all(model.access.map((route) => isProviderConfigured(route.provider)));
  const withStatus = model.access.map((route, index) => ({ route, configured: configuredFlags[index], cooling: isProviderCooling(route.provider) }));

  const pinnedEntry = effectivePin ? withStatus.find((entry) => entry.route.provider === effectivePin && entry.configured) : undefined;
  const rest = withStatus.filter((entry) => entry !== pinnedEntry);
  const healthy = rest.filter((entry) => entry.configured && !entry.cooling);
  const configuredButCooling = rest.filter((entry) => entry.configured && entry.cooling);
  const unconfigured = rest.filter((entry) => !entry.configured);
  const ordered = [...(pinnedEntry ? [pinnedEntry] : []), ...healthy, ...configuredButCooling, ...unconfigured];

  return ordered.map((entry) => ({ provider: entry.route.provider, model: entry.route.id }));
}

/** Expands every entry of a stage chain through expandStageRef and dedupes the
 *  result by provider+model, preserving first-seen order — so a chain of
 *  MODELS (e.g. [nvidia/deepseek-v3.1, anthropic/claude]) becomes a chain of
 *  ROUTES that tries every access route of the first model before moving on to
 *  the second model's routes (docs/FABLE_PLANS.md section 21).
 *
 *  `primaryPin` (docs/FABLE_PLANS.md section 25) is a node's "Access via"
 *  override — it only ever applies to the chain's FIRST entry (the stage's own
 *  primary model), never to fallback entries, which keep resolving through
 *  their own defaultGateways/health ordering. */
async function expandChainByRoutes(chain: StageModelRef[], primaryPin?: ProviderKey): Promise<StageModelRef[]> {
  const expandedGroups = await Promise.all(chain.map((ref, index) => expandStageRef(ref, index === 0 ? primaryPin : undefined)));
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
type StageCallContext = { stream?: SessionStreamController; stageId: string; stageLabel: string };

async function callStageWithFallback(
  rawChain: StageModelRef[],
  prompt: string,
  primaryPin?: ProviderKey,
  callContext?: StageCallContext
): Promise<{ ref: StageModelRef; output: string; notes: string[]; failed: boolean }> {
  const notes: string[] = [];
  // Route-before-model fallback (docs/FABLE_PLANS.md §21, extended by §25's
  // "Access via" node override / default gateways via primaryPin): expand
  // each chain entry to every access route of its catalog model (if known)
  // before the existing "Never Run Dry" cooldown-skip logic below runs — so a
  // cooling route rotates to a sibling route of the SAME model first, and
  // only moves to the next model once every route of the current one is
  // exhausted. Rotation/cooldown notes below are unaffected: they're keyed by
  // provider, same as before expansion.
  const chain = await expandChainByRoutes(rawChain, primaryPin);
  // "Never Run Dry" quota rotation (docs/FABLE_PLANS.md §19): a provider still
  // cooling from a recent 429/quota failure is skipped outright rather than
  // burning another call against it. `next` for the rotation note looks ahead
  // to the next entry that isn't ALSO cooling, so the note names where we're
  // actually headed.
  for (let i = 0; i < chain.length; i++) {
    const ref = chain[i];
    const nextViable = chain.slice(i + 1).find((candidate) => !isProviderCooling(candidate.provider));
    if (isProviderCooling(ref.provider)) {
      const until = providerCooldownUntil(ref.provider)!;
      notes.push(
        `${stageModelLabel(ref)} is rate-limited (cooling ${formatCooldownDuration(until)})${nextViable ? ` — rotated to ${stageModelLabel(nextViable)}.` : "."}`
      );
      continue;
    }
    const next = chain[i + 1];
    // Side-chat card (docs/FABLE_PLANS.md §26): each ATTEMPT (not each skipped
    // cooling entry) gets its own call id, so a fallback rotation renders as a
    // failed card followed by a fresh card for the next attempt.
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
          status: "start"
        }
      });
    }
    try {
      const result = await invokeProvider({ provider: ref.provider, model: ref.model, prompt });
      if (result.source === "placeholder" || !result.output.trim()) {
        const note = `${stageModelLabel(ref)} unavailable${next ? `, falling back to ${stageModelLabel(next)}` : ""}.`;
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
              detail: note
            }
          });
        }
        continue;
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
            output: trimmedOutput.slice(0, 4000)
          }
        });
      }
      return { ref, output: trimmedOutput, notes, failed: false };
    } catch (error) {
      if (isQuotaError(error)) {
        const until = markProviderCooldown(ref.provider, error);
        const note = `${stageModelLabel(ref)} is rate-limited (cooling ${formatCooldownDuration(until)})${next ? ` — rotated to ${stageModelLabel(next)}.` : "."}`;
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
              detail: note
            }
          });
        }
        continue;
      }
      const note = `Failed to call ${stageModelLabel(ref)} (${error instanceof Error ? error.message : String(error)})${next ? `, falling back to ${stageModelLabel(next)}` : ""}.`;
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
            detail: note
          }
        });
      }
    }
  }
  if (chain.every((ref) => isProviderCooling(ref.provider))) {
    notes.push("Every model in this stage's chain is currently cooling down from a rate limit.");
  }
  return { ref: chain[chain.length - 1], output: "", notes: [...notes, "All models for this stage failed."], failed: true };
}

// --- "Is this done?" critic loop (docs/FABLE_PLANS.md §22) ---
// Local tokens are effectively free, so after a stage completes we can afford
// to auto-prompt a local critic model asking whether the output actually
// finished the task, and push the stage model to keep going when it didn't.
// This is what catches "the local model gave up halfway through the file".
const CRITIC_PASS_LIMIT = 4;

type CriticVerdict = { done: boolean; missing: string[] };

/** Calls the local model with a tight completeness-judging template and
 *  parses its verdict defensively. Never throws: any failure to reach the
 *  model or to parse its reply returns null, which callers treat as "skip
 *  critique" — the critic must never be able to turn a working stage into a
 *  failed one. */
async function critiqueStageOutput(stageLabel: string, stagePrompt: string, output: string): Promise<CriticVerdict | null> {
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
    const result = await invokeProvider({ provider: ref.provider, model: ref.model, prompt: criticPrompt });
    if (result.source === "placeholder" || !result.output.trim()) return null;
    const cleaned = stripThinkBlocks(result.output);
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { done?: unknown; missing?: unknown };
    if (typeof parsed.done !== "boolean") return null;
    const missing = Array.isArray(parsed.missing) ? parsed.missing.filter((item): item is string => typeof item === "string") : [];
    return { done: parsed.done, missing };
  } catch {
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
  accessVia?: ProviderKey;
  stageId?: string;
}): Promise<{ output: string; criticPasses: number }> {
  const isLocalStage = args.ref.provider === "ollama";
  if (!(await shouldSelfVerifyStage(args.ref))) return { output: args.output, criticPasses: 0 };
  if (!args.output.trim()) return { output: args.output, criticPasses: 0 };

  const passLimit = isLocalStage ? CRITIC_PASS_LIMIT : 1;
  let currentOutput = args.output;
  let passes = 0;

  for (let i = 0; i < passLimit; i++) {
    const verdict = await critiqueStageOutput(args.stageLabel, args.stagePrompt, currentOutput);
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
      args.accessVia,
      args.stageId ? { stream: args.stream, stageId: args.stageId, stageLabel: args.stageLabel } : undefined
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
// Scoped like the directive bus: projectPath or "global". Checked at stage /
// repair / recovery boundaries — an in-flight provider call finishes first.
const cancelledScopes = new Set<string>();

function requestSessionCancel(projectPath?: string): void {
  cancelledScopes.add(directiveScopeKey(projectPath));
}

function clearSessionCancel(projectPath?: string): void {
  cancelledScopes.delete(directiveScopeKey(projectPath));
}

function throwIfCancelled(projectPath?: string): void {
  const scope = directiveScopeKey(projectPath);
  if (cancelledScopes.has(scope)) {
    cancelledScopes.delete(scope);
    throw new Error("Stopped by user.");
  }
}

// --- Session directive bus (mid-run steering; docs/AGENTIC_ROADMAP.md §3) ---
const sessionDirectives = new Map<string, SessionDirective[]>();

function directiveScopeKey(projectPath?: string): string {
  return projectPath?.trim() || "global";
}

async function postSessionDirective(input: { projectPath?: string; conversationId?: string; text: string }): Promise<SessionDirective> {
  const text = input.text.trim();
  if (!text) throw new Error("A directive needs text.");
  const scopeKey = directiveScopeKey(input.projectPath);
  const directive: SessionDirective = {
    id: randomUUID(),
    scopeKey,
    fromConversationId: input.conversationId,
    createdAt: new Date().toISOString(),
    text,
    status: "pending"
  };
  sessionDirectives.set(scopeKey, [...(sessionDirectives.get(scopeKey) ?? []), directive]);
  await appendAudit("info", "session.directive", `Mid-run direction queued: ${text.slice(0, 120)}`, { scopeKey, conversationId: input.conversationId });
  return directive;
}

function listSessionDirectives(projectPath?: string): SessionDirective[] {
  return sessionDirectives.get(directiveScopeKey(projectPath)) ?? [];
}

/** Pop pending directives for this project and mark them applied at the given stage. */
function takePendingDirectives(projectPath: string | undefined, stageId: string): SessionDirective[] {
  const scopeKey = directiveScopeKey(projectPath);
  const all = sessionDirectives.get(scopeKey) ?? [];
  const pending = all.filter((directive) => directive.status === "pending");
  if (pending.length === 0) return [];
  sessionDirectives.set(
    scopeKey,
    all.map((directive) => (directive.status === "pending" ? { ...directive, status: "applied" as const, appliedAtStage: stageId } : directive))
  );
  return pending.map((directive) => ({ ...directive, status: "applied" as const, appliedAtStage: stageId }));
}

async function runOrchestratedStages(
  prompt: string,
  stream?: SessionStreamController,
  override?: SessionModelOverride,
  projectPath?: string,
  metisFile?: { content: string; chars: number } | null,
  permissionMode: PermissionMode = "auto"
): Promise<{ stages: OrchestrationStage[]; designSeed: DesignSeed }> {
  const metisBlock = metisFilePromptBlock(metisFile ?? null);
  const singleFile = wantsSingleFileFrontend(prompt);
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

  for (const stage of stages) {
    throwIfCancelled(projectPath);
    let stagePrompt: string;
    if (stage.templateRole === "plan") {
      stagePrompt = `You are the PLANNING model in a build pipeline. The user wants:\n${prompt}\n\nWrite a short, concrete build plan: the pages/components, the data, and the interactivity. Be tight — no code yet, just the plan.\n\nNever ask the user for a brief, requirements, or say the project is empty. If details are missing, invent tasteful, specific choices yourself (name, copy, palette, content) and state them briefly — you are the creative lead. Do not end with a question asking permission to proceed; proceed.`;
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
        emitTimeline(stream, timelineText(`Style reference: "${trimmedCaption}"`));
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
    // AskUserQuestion (docs/FABLE_PLANS.md section 24): models MAY emit this
    // tag ONCE per stage for a genuinely blocking decision — never for "what
    // would you like to build", since the model remains the creative lead.
    stagePrompt += `\n\nIf, and only if, a genuinely blocking decision needs the user's input (not a creative choice you can make yourself), you may emit ONE tag anywhere in your output: <ask_user>{"question":"...","options":["a","b"]}</ask_user>. Otherwise never emit this tag — decide tastefully yourself and proceed.`;
    if (stage.templateRole === "plan") {
      emitTimeline(stream, timelineText("Planning the build and checking the constraints."));
    } else if (stage.templateRole === "frontend") {
      emitTimeline(stream, timelineText("Calling the front-end route now."));
    } else {
      emitTimeline(stream, timelineText("Checking whether the build needs functionality or support files."));
    }
    const stageCallContext: StageCallContext = { stream, stageId: stage.id, stageLabel: stage.label };
    let attempt = await callStageWithFallback(stage.chain, stagePrompt, stage.accessVia, stageCallContext);
    // Scan for an AskUserQuestion tag; if present, pause for an answer, strip
    // the tag, append the answer to the stage prompt, and re-run once.
    const askedQuestion = extractAskUserTag(attempt.output);
    if (askedQuestion) {
      const { answer, timedOut } = await promptUserQuestion(stream, askedQuestion.question, askedQuestion.options);
      if (timedOut) {
        emitTimeline(stream, timelineText(`No answer in time — I picked "${answer}" and kept going.`));
      }
      const continuationPrompt = `${stagePrompt}\n\nYou previously asked: "${askedQuestion.question}"\nUser answered: ${answer}\n\nContinue with the full stage output now (do not ask again).`;
      attempt = await callStageWithFallback(stage.chain, continuationPrompt, stage.accessVia, stageCallContext);
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
        accessVia: stage.accessVia,
        stageId: stage.id
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
      stageLabel: `Repair pass ${repairCount}`
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
      stageLabel: recoveryStageLabel
    });
    const thoughts = splitThinkTaggedOutput(attempt.output).thoughts;
    let cleanOutput = stripThinkBlocks(attempt.output);
    // One cheap critique pass here too (docs/FABLE_PLANS.md §22) — skipped
    // entirely if the critic is unreachable/unparseable or self-verify is off.
    let criticPasses = 0;
    if (!attempt.failed && cleanOutput.trim() && (await shouldSelfVerifyStage(attempt.ref))) {
      const verdict = await critiqueStageOutput(`File recovery ${attemptNumber}`, recoveryPrompt, cleanOutput);
      if (verdict && !verdict.done) {
        criticPasses = 1;
        const firstMissing = (verdict.missing[0] ?? "the rest of the files").trim();
        emitTimeline(args.stream, timelineText(`Self-check: still missing ${firstMissing.length > 100 ? `${firstMissing.slice(0, 97)}...` : firstMissing} — continuing.`));
        const missingList = verdict.missing.length > 0 ? verdict.missing.map((item) => `- ${item}`).join("\n") : "- (no specifics given, but the task is not finished)";
        const continuationPrompt = `${recoveryPrompt}\n\nYour previous output was incomplete. You MUST complete: \n${missingList}\n\nContinue and return the COMPLETE result (full files, not diffs).\n\nYour previous output:\n${cleanOutput.slice(0, 8000)}`;
        const retryAttempt = await callStageWithFallback(chain, continuationPrompt, undefined, {
          stream: args.stream,
          stageId: recoveryStageId,
          stageLabel: recoveryStageLabel
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
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Session run requires a prompt.");
  clearSessionCancel(input.projectPath);

  const permissionMode = resolvePermissionMode(input);

  const createdAt = new Date().toISOString();
  const conversationId = input.conversationId ?? randomUUID();
  const promptHash = sha256(prompt);
  const decision = await decidePolicy({
    prompt,
    preset: input.preset
  });
  const previousRun = isAttributionQuestion(prompt) ? await previousConversationRun(input.conversationId) : null;
  const routeContext = shouldReusePreviousPipeline(prompt) ? await previousConversationTaskType(input.conversationId) : null;
  const routeLabel = routeLabelFromPrompt(prompt) ?? (shouldReusePreviousPipeline(prompt) ? await previousConversationRouteLabel(input.conversationId) : undefined);
  const effectiveDecision = applySessionRouteOverrides(prompt, decision.decision, routeContext);
  const effectiveDecisionResult: PolicyDecisionResult = { ...decision, decision: effectiveDecision };

  // "Set up a preview" is an OPERATION on the existing project, not a build —
  // serve the selected folder and open the rail instead of running the pipeline.
  if (wantsProjectPreview(prompt)) {
    return runPreviewRequest({ input, prompt, conversationId, createdAt, promptHash, decision: effectiveDecisionResult, stream });
  }

  // Real multi-model build pipeline (plan -> front end -> functional) for "build me X".
  if (shouldRunBuildPipeline(prompt, effectiveDecision, decision.source)) {
    const singleFile = wantsSingleFileFrontend(prompt);
    emitTimeline(stream, timelineText("I’ll run this through the build pipeline and turn the model output into real project files."));
    if (input.modelOverride) {
      emitTimeline(stream, timelineText(`You pinned ${overrideDisplayLabel(input.modelOverride)}, so it leads every stage; the usual chain stays as fallback.`));
    }
    emitTimeline(stream, { id: randomUUID(), kind: "route", label: "Build", pipelineName: "Build Orchestration Pipeline" });
    emitStream(stream, {
      kind: "step",
      step: {
        id: "route",
        label: input.modelOverride ? `Model pinned: ${overrideDisplayLabel(input.modelOverride)}` : "Route through Metis Policy",
        detail: input.modelOverride ? "Router bypassed for the primary attempt of each stage." : "Selected the build pipeline.",
        status: "complete",
        completedAt: new Date().toISOString()
      }
    });
    const writable = await resolveWritableProjectWorkspace(input.projectPath);
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
    const { stages, designSeed } = await runOrchestratedStages(prompt, stream, input.modelOverride, input.projectPath, metisFile, permissionMode);
    let files: GeneratedFile[] = [];
    let projectResult: ProjectToolResult | undefined;
    let repairCount = 0;
    if (permissionMode === "plan") {
      // Plan mode: no extraction, no writes, no commands, no repair/recovery —
      // the stage loop already stopped after "plan" (docs/FABLE_PLANS.md §24).
    } else {
    files = extractProjectFiles(stages);
    // Never give up on 0 extracted files without a fight — ask the build model
    // again, explicitly, before conceding nothing was written.
    if (files.length === 0) {
      throwIfCancelled(input.projectPath);
      files = await runExtractionRecovery({ prompt, stages, override: input.modelOverride, stream, metisFile });
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
        metisFile
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
      promptPreview: prompt.slice(0, 180),
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
      designSeed: { id: designSeed.id, name: designSeed.name }
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
    await appendRunToConversation(run, prompt);
    await writeSessionRun(run);
    emitStream(stream, { kind: "complete", run });
    return run;
  }

  const pipelineName = pipelineNameFor(effectiveDecision);
  const includeProjectTools = shouldCreateFrontendProject(prompt, effectiveDecision);
  const steps = initialPipelineSteps(pipelineName, effectiveDecision, includeProjectTools);
  steps[0] = completeStep(steps[0]);

  const orchestrationAudit = await appendAudit("info", "session.pipeline", `Running ${pipelineName}.`, {
    pipeline: pipelineName,
    task_type: effectiveDecision.task_type,
    prompt_sha256: promptHash
  });
  steps[1] = completeStep(steps[1], orchestrationAudit.id);

  const route = effectiveDecision.selected_route;
  const override = input.modelOverride;
  const provider = override ? override.provider : providerFromRoute(route.provider, route.runtime, route.kind);
  const model = override ? resolveOverrideModel(override) : route.model ?? providerInfo[provider].defaultModel ?? "auto";
  const effectiveRouteLabel = override ? overrideDisplayLabel(override) : routeLabel;
  const writableWorkspace = await resolveWritableProjectWorkspace(input.projectPath);
  const projectSnapshot = writableWorkspace ? await buildProjectSnapshot(writableWorkspace.path) : undefined;
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
  const showRouteCeremony = Boolean(override) || shouldStreamRouteCeremony(prompt, effectiveDecision, includeProjectTools, projectCommandOperations);
  if (showRouteCeremony) {
    emitTimeline(
      stream,
      timelineText(override ? `You pinned ${overrideDisplayLabel(override)} — skipping the router and calling it directly.` : "I’m checking the route and preparing the selected model.")
    );
    emitTimeline(stream, { id: randomUUID(), kind: "route", label: effectiveRouteLabel ?? pipelineName.replace(/\s*Orchestration Pipeline$/i, "").replace(/\s*Assistant Pipeline$/i, ""), pipelineName });
  }
  // Design seed: only for the chat-path project-tools flow (frontend builds
  // via createFrontendProject), and never overrides explicit user taste.
  const chatDesignSeed = includeProjectTools ? pickDesignSeed(prompt) : undefined;
  if (chatDesignSeed) emitTimeline(stream, timelineText(designSeedTimelineText(chatDesignSeed)));
  const sessionPrompt = sessionProviderPrompt(prompt, effectiveDecision, pipelineName, previousRun, projectSnapshot, chatDesignSeed, metisFile);
  const overrideWarnings: string[] = [];
  let providerResult: ProviderInvokeResult;
  try {
    providerResult = await invokeProvider({ provider, model, prompt: sessionPrompt }, stream);
  } catch (error) {
    if (!override) throw error;
    // A pinned model can be a hand-typed custom entry — fall back to the provider default instead of failing the run.
    const fallbackModel = providerInfo[provider].defaultModel ?? "auto";
    overrideWarnings.push(
      `Failed to call ${overrideDisplayLabel(override)} (${error instanceof Error ? error.message : String(error)}), falling back to ${providerInfo[provider].label} (${fallbackModel}).`
    );
    emitTimeline(stream, timelineText(`Couldn’t reach ${overrideDisplayLabel(override)} — falling back to ${providerInfo[provider].label} (${fallbackModel}).`));
    providerResult = await invokeProvider({ provider, model: fallbackModel, prompt: sessionPrompt }, stream);
  }
  if (showRouteCeremony) emitTimeline(stream, timelineText("The selected model responded. I’m recording the trace and any follow-up project tools."));
  steps[2] = completeStep(steps[2], providerResult.auditId);

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
    ...(chatDesignSeed ? { designSeed: { id: chatDesignSeed.id, name: chatDesignSeed.name } } : {})
  };
  if (permissionMode === "plan" && projectToolsIndex >= 0) {
    run.assistantText = `${run.assistantText}\n\nPlan mode — nothing was written. Switch to Auto and rerun to build it.`;
  }

  await appendRunToConversation(run, prompt);
  await writeSessionRun(run);
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
async function extractPaletteFromImage(src: string): Promise<{ palette: string[]; base64?: string }> {
  const decoded = await decodeImageForPalette(src);
  if (!decoded) return { palette: [] };
  try {
    const resized = decoded.image.resize({ width: 64 });
    const bitmap = resized.toBitmap();
    const palette = medianCutPalette(bitmap, 5);
    return { palette, base64: decoded.base64 };
  } catch {
    return { palette: [], base64: decoded.base64 };
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
  "Look at this image from a design/style moodboard. Respond with ONLY a JSON object, no other text: " +
  '{"caption": "one concise sentence describing the visual style", "tags": ["3 to 6 lowercase mood or style tags"]}.';

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
  const { palette, base64 } = await extractPaletteFromImage(image.src);
  const visionModel = await detectOllamaVisionModel();
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
        createdAt: new Date().toISOString()
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
    createdAt: new Date().toISOString()
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
    userEdited: true
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

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "Metis Orchestrator",
    backgroundColor: "#1b1b1b",
    frame: false,
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
  ipcMain.handle("metis-bus:post", (_event, input: { projectPath?: string; conversationId?: string; text: string }) => postSessionDirective(input));
  ipcMain.handle("metis-bus:list", (_event, projectPath?: string) => listSessionDirectives(projectPath));
  ipcMain.handle("metis-conversations:list", () => readConversations());
  ipcMain.handle("metis-conversations:create", (_event, projectPath?: string, firstPrompt?: string) => createConversation(projectPath, firstPrompt));
  ipcMain.handle("metis-conversations:delete", (_event, id: string) => deleteConversation(id));
  ipcMain.handle("metis-conversations:delete-project", (_event, projectPath?: string) => deleteProjectConversations(projectPath));
  ipcMain.handle("metis-conversations:rename", (_event, id: string, title: string) => renameConversation(id, title));
  ipcMain.handle("metis-conversations:archive", (_event, id: string, archived: boolean) => archiveConversation(id, archived));
  ipcMain.handle("metis-lab:run-experiment", (_event, prompt?: string) => runLabExperiment(prompt));
  ipcMain.handle("metis-project:get-workspace", () => readProjectWorkspace());
  ipcMain.handle("metis-project:snapshot", () => snapshotCurrentProject());
  ipcMain.handle("metis-project:select-folder", () => selectProjectWorkspace());
  ipcMain.handle("metis-project:clear-workspace", () => clearProjectWorkspace());
  ipcMain.handle("metis-project:list-resources", () => listProjectResources());
  ipcMain.handle("metis-project:add-files", () => addProjectResource("file"));
  ipcMain.handle("metis-project:add-folder", () => addProjectResource("folder"));
  ipcMain.handle("metis-project:remove-resource", (_event, id: string) => removeProjectResource(id));
  ipcMain.handle("metis-files:read", (_event, path: string) => readMetisFile(path));
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
  ipcMain.on("metis-session:answer-question", (_event, id: string, answer: string) => respondToUserQuestion(id, answer));
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
  ipcMain.handle("metis-catalog:models", () => listModelCatalog());
  ipcMain.handle("metis-pulse:feed", () => listPulseFeed());
  ipcMain.handle("metis-routines:list", () => listRoutines());
  ipcMain.handle("metis-routines:save", (_event, input: Routine) => saveRoutine(input));
  ipcMain.handle("metis-routines:delete", (_event, id: string) => deleteRoutine(id));
  ipcMain.handle("metis-routines:run-now", (_event, id: string) => runRoutineNow(id));
  ipcMain.handle("metis-gallery:analyze-board", (_event, boardId: string) => analyzeGalleryBoard(boardId));
  ipcMain.handle("metis-gallery:cards", () => listStyleCards());
  ipcMain.handle("metis-gallery:update-card", (_event, imageId: string, boardId: string, patch: StoredStyleCardPatch) => updateStyleCard(imageId, boardId, patch));
  ipcMain.handle("metis-gallery:delete-card", (_event, imageId: string) => deleteStyleCard(imageId));
  ipcMain.handle("metis-gallery:analyze-image", (_event, boardId: string, imageId: string) => analyzeGalleryImage(boardId, imageId));
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
