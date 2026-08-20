/** The Metis Gateway, lifted out of main.ts.
 *
 *  Carved 2026-08-20 as the first cut of docs/STRUCTURAL_DEBT.md item 1 — 78% of
 *  `src` sat in two files, which is why no model can work on this repo (it
 *  cannot return a 742 KB file complete) and why those two files could only ever
 *  be grepped rather than read.
 *
 *  It TAKES its dependencies rather than importing them, and that is the whole
 *  design. The gateway calls 35 functions that live in main.ts; importing them
 *  would make `main -> gateway -> main`, a cycle. But 29 of those 35 are members
 *  of the two dispatch tables, so those are passed in as VALUES and the injected
 *  surface collapses to the thirteen entries below.
 *
 *  The payoff is not tidiness. A gateway built from injected dependencies can be
 *  constructed in a test with fakes, so `handleGatewayRequest` is reachable
 *  offline for the first time — docs/STRUCTURAL_DEBT.md item 4 falling out of
 *  item 1. Before this, suite 28 could only assert that the SOURCE of these
 *  routes looked right.
 */

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type {
  AuditEvent,
  GatewayStatus,
  OllamaListResult,
  PolicyDecisionInput,
  PolicyDecisionResult,
  ProviderInvokeInput,
  ProviderInvokeResult,
  ProviderKey,
  SessionModelOverride,
  SessionStreamEvent
} from "../shared/runtime-contracts.js";
import type { RouteDecision } from "../shared/policy-contract.js";
import type { LoopRecord } from "./loops.js";

/** Structural twin of main.ts's private `SessionStreamController`.
 *
 *  Exactly the trick `cli.ts` already uses for the same reason: main.ts never
 *  exports that type and does not need to, because TypeScript matches by shape
 *  rather than by name. An object built from this type passes into the injected
 *  `invokeProvider` as if it were main's own.
 *
 *  Worth noticing that the CLI reached this same design independently — an
 *  injected runtime interface plus a structural twin. This carve is not
 *  inventing a pattern, it is applying the one already in the repo. */
export type GatewayStreamEmitter = { emit: (event: SessionStreamEvent) => void };
import { bridgeMemberIsHttpReadable, bridgeMemberIsHttpReducible } from "../shared/bridge-manifest.js";
import { gatewayLoopsPage } from "./gateway-loops-page.js";
import {
  GATEWAY_APP_PREFIX,
  gatewayAppAssetPath,
  gatewayAppMissingBuildPage,
  gatewayAppShell,
  isGatewayAppDocument,
  isGatewayAppRedirect
} from "./gateway-app-shell.js";

/** Everything the gateway needs that lives in main.ts.
 *
 *  `reads` and `reducers` are the two dispatch tables, passed as values: main
 *  builds them because their 29 members are main's own functions, and the
 *  gateway only ever looks a member up and calls it. That is what keeps this
 *  interface at thirteen entries rather than forty-two. */
export interface GatewayDeps {
  reads: Readonly<Record<string, (args: readonly unknown[]) => unknown>>;
  reducers: Readonly<Record<string, (args: readonly unknown[]) => unknown>>;
  appendAudit: (level: AuditEvent["level"], kind: string, summary: string, metadata?: Record<string, unknown>) => Promise<AuditEvent>;
  readStoreValue: <T>(key: string, fallback: T) => Promise<T>;
  writeStoreValue: <T>(key: string, value: T) => Promise<void>;
  listOllamaModels: () => Promise<OllamaListResult>;
  listLoops: () => Promise<LoopRecord[]>;
  stopLoop: (id: string, reason?: string) => Promise<LoopRecord | undefined>;
  decidePolicy: (input: PolicyDecisionInput, options?: { signal?: AbortSignal; silent?: boolean }) => Promise<PolicyDecisionResult>;
  applySessionRouteOverrides: (prompt: string, decision: RouteDecision, routeContext?: RouteDecision["task_type"] | null) => RouteDecision;
  providerFromRoute: (provider: string | undefined, runtime: string | undefined, kind: string) => ProviderKey;
  resolveOverrideModel: (override: SessionModelOverride) => string;
  invokeProvider: (input: ProviderInvokeInput, stream?: GatewayStreamEmitter) => Promise<ProviderInvokeResult>;
  serveStaticFile: (root: string, rawUrl: string, response: ServerResponse) => Promise<void>;
  /** The provider's default model id. Injected as a lookup rather than as
   *  main's whole `providerInfo` table, because one field is all the gateway
   *  reads and a table would drag its shape along too. */
  providerDefaultModel: (provider: ProviderKey) => string | undefined;
  /** Where the renderer build lives. Passed in rather than derived, because
   *  `__dirname` in this file is not `__dirname` in main.ts. */
  rendererDist: string;
}

let injected: GatewayDeps | null = null;

/** Wire the gateway. Called once from main.ts before anything can serve.
 *
 *  Module-level rather than a closure over 500 lines of handlers, deliberately:
 *  wrapping every function in a factory would have meant reindenting the whole
 *  file, and a 500-line whitespace diff is one nobody can review. The carve is
 *  worth more than the purity, and the seam is the same either way. */
export function configureGateway(deps: GatewayDeps): void {
  injected = deps;
}

/** The wired dependencies, or a loud failure. Never returns a half-built
 *  gateway: serving with a missing dependency would surface as a 500 from a
 *  route that looks correct, which is harder to diagnose than not starting. */
function need(): GatewayDeps {
  if (!injected) throw new Error("The Metis Gateway was used before configureGateway() ran.");
  return injected;
}

// ---------------------------------------------------------------------------
// Metis Gateway (DRILL_PLAN P10.1): a LOOPBACK-ONLY, OFF-by-default
// OpenAI-compatible HTTP server so any OpenAI-client app can point its base
// URL at Metis and get the same Auto Router (decidePolicy + applySessionRouteOverrides
// + providerFromRoute) that the chat composer uses, or call a specific
// provider/model directly. Deliberately does NOT touch runSession or the
// build pipeline — this is the minimal "call one model and hand back the
// text" surface, mirroring the chat path's final invokeProvider call, not
// the whole orchestration/project-tools/knowledge-bank machinery around it.
// Binds strictly to 127.0.0.1 (never 0.0.0.0) via the same
// createServer/listen(port, "127.0.0.1") pattern ensureStaticPreview uses
// above, and every handler is wrapped so a bad request or a downstream
// provider failure returns an OpenAI-shaped error instead of ever throwing
// out of the server or crashing the app.
// ---------------------------------------------------------------------------

const GATEWAY_DEFAULT_PORT = 11500;
const GATEWAY_MAX_BODY_BYTES = 4 * 1024 * 1024; // 4MB — generous for a chat turn, hard cap against a runaway/abusive body.

let gatewayServer: Server | null = null;
let cachedGatewayToken: string | null = null;

type GatewayChatMessage = { role?: string; content?: string };
type GatewayChatRequest = { model?: string; messages?: GatewayChatMessage[]; stream?: boolean };

/** Per-install bearer token (DRILL_PLAN P10.1 §3): auto-generated once and
 *  persisted under the `gatewayToken` store key, exactly like every other
 *  readStoreValue/writeStoreValue-backed setting in this file. Required on
 *  every gateway request so a loopback-bound API can't be silently used as
 *  an open prompt-proxy by other local software sharing this machine. */
async function readOrCreateGatewayToken(): Promise<string> {
  if (cachedGatewayToken) return cachedGatewayToken;
  const existing = await need().readStoreValue<string>("gatewayToken", "");
  if (existing) {
    cachedGatewayToken = existing;
    return existing;
  }
  const token = randomBytes(24).toString("hex");
  await need().writeStoreValue("gatewayToken", token);
  cachedGatewayToken = token;
  return token;
}

/** Constant-time-ish bearer check: length mismatch short-circuits (no secret
 *  material to compare in that case), otherwise timingSafeEqual guards
 *  against a naive substring-timing attack on the token. */
function gatewayTokenMatches(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length === 0 || providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function gatewayRoleLabel(role?: string): string {
  if (role === "system") return "System";
  if (role === "assistant") return "Assistant";
  return "User";
}

/** Flattens an OpenAI `messages` array into a single prompt the same way the
 *  Manager chat path does it (runManagerChatStream above): a role-prefixed
 *  "Role: content" join, one turn per line, with a trailing generation cue.
 *  No dedicated flattener is exported elsewhere in this file for reuse, so
 *  this mirrors that existing inline pattern rather than inventing a new shape. */
function flattenGatewayMessages(messages: GatewayChatMessage[]): string {
  const lines = messages
    .filter((message): message is GatewayChatMessage & { content: string } => typeof message?.content === "string" && message.content.trim().length > 0)
    .map((message) => `${gatewayRoleLabel(message.role)}: ${message.content}`);
  return [...lines, "Assistant:"].join("\n\n");
}

function gatewayLastUserMessage(messages: GatewayChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].role ?? "user") === "user" && typeof messages[i].content === "string") return messages[i].content as string;
  }
  const last = messages[messages.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

function writeGatewayJson(res: ServerResponse, status: number, payload: unknown): void {
  try {
    const body = JSON.stringify(payload);
    if (!res.headersSent) {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(body);
  } catch {
    // Response stream may already be closed/errored — nothing more to do.
  }
}

function gatewayErrorPayload(message: string, type: string): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

/** Reads a request body up to `maxBytes`, rejecting (not throwing) past the
 *  cap so a runaway/abusive client can't grow this in memory unbounded. */
function readGatewayBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Resolves { provider, model } for a chat completion request exactly like
 *  the chat composer's Auto/pinned split (runSession, lines ~7841-7844):
 *  metis-auto/empty/"unknown" runs decidePolicy + applySessionRouteOverrides
 *  on the last user message and derives provider/model from the selected
 *  route via providerFromRoute, same as an Auto Router turn; any other
 *  string is treated as a pinned model id, resolved via providerFromRoute
 *  (heuristic name-sniffing) + resolveOverrideModel (display-name/tag
 *  normalization) exactly like a composer-pinned override. */
async function resolveGatewayRoute(requestedModel: string, lastUserMessage: string, fallbackPrompt: string): Promise<{ provider: ProviderKey; model: string }> {
  const trimmed = requestedModel.trim();
  if (!trimmed || trimmed === "metis-auto" || trimmed === "unknown") {
    const routingPrompt = lastUserMessage.trim() || fallbackPrompt;
    const decision = await need().decidePolicy({ prompt: routingPrompt });
    const effectiveDecision = need().applySessionRouteOverrides(routingPrompt, decision.decision);
    const route = effectiveDecision.selected_route;
    const provider = need().providerFromRoute(route.provider, route.runtime, route.kind);
    const model = route.model ?? need().providerDefaultModel(provider) ?? "auto";
    return { provider, model };
  }
  const provider = need().providerFromRoute(trimmed, undefined, trimmed);
  const model = need().resolveOverrideModel({ provider, model: trimmed });
  return { provider, model };
}

function buildGatewayNonStreamResponse(result: ProviderInvokeResult, requestedModelLabel: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModelLabel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.output },
        finish_reason: "stop"
      }
    ],
    ...(result.usage
      ? {
          usage: {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.inputTokens + result.usage.outputTokens
          }
        }
      : {})
  };
}

/** Streams an SSE `chat.completion.chunk` sequence. Reuses invokeProvider's
 *  existing SessionStreamController hook (the same one invokeOllamaProviderStream
 *  emits message_delta/thought_delta on) via a small adapter, exactly the way
 *  runManagerChatStream bridges it to its own event union above — only
 *  message_delta is forwarded (thought_delta has no standard OpenAI field, and
 *  this gateway is scoped to the final answer only). invokeProvider only
 *  streams for the ollama branch; a cloud provider call resolves in one shot
 *  with no deltas emitted, so `streamedAny` stays false and the full text is
 *  sent as a single delta chunk after it resolves — same fallback shape
 *  runManagerChatStream relies on, just applied per-chunk here instead of
 *  per-turn. Never throws: a downstream failure is folded into the stream as
 *  a final error note, [DONE] always terminates it. */
async function streamGatewayChatCompletion(res: ServerResponse, provider: ProviderKey, model: string, prompt: string, requestedModelLabel: string): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const sendChunk = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: requestedModelLabel,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
    try {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    } catch {
      // Client may have disconnected mid-stream — nothing more to do.
    }
  };
  sendChunk({ role: "assistant" });
  let streamedAny = false;
  const streamAdapter: GatewayStreamEmitter = {
    emit: (event) => {
      if (event.kind === "message_delta" && event.delta) {
        streamedAny = true;
        sendChunk({ content: event.delta });
      }
    }
  };
  try {
    const result = await need().invokeProvider({ provider, model, prompt }, streamAdapter);
    if (!streamedAny && result.output) sendChunk({ content: result.output });
  } catch (error) {
    sendChunk({ content: `\n\n[gateway error: ${error instanceof Error ? error.message : String(error)}]` });
  } finally {
    sendChunk({}, "stop");
    try {
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {
      // Client may have disconnected — the server-side stream is already done either way.
    }
  }
}

async function handleGatewayModelsList(res: ServerResponse): Promise<void> {
  const ollama = await need().listOllamaModels();
  const data = [{ id: "metis-auto", object: "model" }, ...ollama.installed.map((name) => ({ id: name, object: "model" }))];
  writeGatewayJson(res, 200, { object: "list", data });
}

async function handleGatewayChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestStart = Date.now();
  let modelForAudit = "unknown";
  let ok = true;
  let errorMessage: string | undefined;
  try {
    const raw = await readGatewayBody(req, GATEWAY_MAX_BODY_BYTES);
    let body: GatewayChatRequest;
    try {
      body = raw ? (JSON.parse(raw) as GatewayChatRequest) : {};
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      writeGatewayJson(res, 400, gatewayErrorPayload("`messages` must be a non-empty array.", "invalid_request_error"));
      ok = false;
      errorMessage = "empty messages array";
      return;
    }
    const flattenedPrompt = flattenGatewayMessages(messages);
    const lastUserMessage = gatewayLastUserMessage(messages);
    const requestedModelLabel = (body.model ?? "").trim() || "metis-auto";
    const { provider, model } = await resolveGatewayRoute(requestedModelLabel, lastUserMessage, flattenedPrompt);
    modelForAudit = model;

    if (body.stream) {
      await streamGatewayChatCompletion(res, provider, model, flattenedPrompt, requestedModelLabel);
    } else {
      const result = await need().invokeProvider({ provider, model, prompt: flattenedPrompt });
      writeGatewayJson(res, 200, buildGatewayNonStreamResponse(result, requestedModelLabel));
    }
  } catch (error) {
    ok = false;
    errorMessage = error instanceof Error ? error.message : String(error);
    writeGatewayJson(res, 500, gatewayErrorPayload(errorMessage, "internal_error"));
  } finally {
    const ms = Date.now() - requestStart;
    // Audit deliberately carries only the model id + timing + ok/error — never
    // the prompt/messages content (DRILL_PLAN P10.1 §4).
    await need().appendAudit(ok ? "info" : "warning", "gateway.request", `Gateway ${ok ? "served" : "failed"} ${modelForAudit} in ${ms}ms.`, {
      model: modelForAudit,
      ms,
      ...(errorMessage ? { error: errorMessage } : {})
    });
  }
}


/** `POST /v1/bridge` — one route for every read, allowlisted per member.
 *
 *  One route rather than 26 because the allowlist IS the security boundary and
 *  a single choke point is one place to audit, not twenty-six. The member name
 *  is data, checked against the manifest before anything is called; an
 *  unrecognised or non-permitted member never reaches the table. */
async function handleGatewayBridgeRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Same reader and the same size cap the chat route uses, rather than a second
  // one that would drift from it.
  const raw = await readGatewayBody(req, GATEWAY_MAX_BODY_BYTES).catch(() => "");
  let body: { member?: unknown; args?: unknown } | null = null;
  try {
    body = raw ? (JSON.parse(raw) as { member?: unknown; args?: unknown }) : null;
  } catch {
    writeGatewayJson(res, 400, gatewayErrorPayload("Request body must be valid JSON.", "invalid_request_error"));
    return;
  }
  const member = typeof body?.member === "string" ? body.member : "";
  const args = Array.isArray(body?.args) ? body.args : [];
  if (!member) {
    writeGatewayJson(res, 400, gatewayErrorPayload("A member name is required, e.g. { member: \"metisUsage.summary\" }.", "invalid_request_error"));
    return;
  }
  // The manifest decides, not the table. Checked first so a member that is
  // wired but no longer permitted is refused rather than quietly served, and
  // asked in two separate questions so a read can never fall through into the
  // reducer table or the other way round.
  const readable = bridgeMemberIsHttpReadable(member);
  const reducible = !readable && bridgeMemberIsHttpReducible(member);
  if (!readable && !reducible) {
    writeGatewayJson(res, 403, gatewayErrorPayload(`"${member}" is not readable over HTTP.`, "permission_error"));
    return;
  }
  const handler = readable ? need().reads[member] : need().reducers[member];
  if (!handler) {
    writeGatewayJson(res, 501, gatewayErrorPayload(`"${member}" is permitted but not wired.`, "not_found"));
    return;
  }
  try {
    const value = await handler(args);
    // Reads are not audited — they are the overwhelming majority of traffic and
    // recording them would bury the lines that matter. A reduce CHANGES what
    // the machine is doing, so it leaves a trace naming the member, the same
    // way the stop route does.
    if (reducible) {
      await need().appendAudit("info", "gateway.bridge.reduce", `A browser client called ${member}.`, { member });
    }
    // IPC transports `undefined`; JSON does not. Collapsing to null keeps a
    // "nothing there" answer as a settled promise rather than a key that
    // vanishes from the payload and reads as a hang on the other side.
    writeGatewayJson(res, 200, { ok: true, value: value === undefined ? null : value });
  } catch (error) {
    writeGatewayJson(res, 500, gatewayErrorPayload(error instanceof Error ? error.message : String(error), "internal_error"));
  }
}

/** Top-level request handler for the gateway HTTP server. Every path — auth
 *  failure, unknown route, thrown error — resolves to an OpenAI-shaped JSON
 *  error response; nothing here is allowed to propagate an exception back to
 *  the http.Server (which would otherwise risk taking the whole process down). */
export async function handleGatewayRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = await readOrCreateGatewayToken();
    const authHeader = req.headers.authorization ?? "";

    // The ONE branch that runs before the bearer check, and the reasoning is in
    // gateway-app-shell.ts: a <script src> cannot carry an Authorization
    // header, so the renderer bundle either gets served unauthenticated or the
    // gateway grows an ambient cookie credential — and an ambient credential
    // hands every other page in the browser a CSRF path to the route that
    // spends money. The bundle is the app's own compiled code, identical to
    // what is inside the public installer, carrying no key and no user data.
    // Disclosing it to another loopback process discloses a public artifact.
    // Scoped to /app/assets/ so a file appearing at the dist root later is not
    // served by default, and served through serveStaticFile so it inherits the
    // isPathInside + realpath containment rather than a second hand-rolled one.
    const assetPath = req.method === "GET" ? gatewayAppAssetPath(url.pathname) : null;
    if (assetPath) {
      await need().serveStaticFile(need().rendererDist, assetPath, res);
      return;
    }

    // A browser cannot attach an Authorization header to a URL you type or
    // scan, so the page has one bootstrap route in: ?token=. Deliberately
    // narrow — only the HTML pages accept it, never the JSON routes, and the
    // page's first act is to move the token into sessionStorage and strip it
    // from the address bar. A token in a URL lands in history and in any
    // proxy log, which is survivable for a loopback service reached over a
    // private tunnel and would not be for a public one.
    const pageBootstrap =
      req.method === "GET" &&
      (url.pathname === "/" ||
        url.pathname === "/loops" ||
        isGatewayAppRedirect(url.pathname) ||
        isGatewayAppDocument(url.pathname));
    const provided = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1] ?? (pageBootstrap ? (url.searchParams.get("token") ?? "") : "");
    if (!gatewayTokenMatches(provided, token)) {
      writeGatewayJson(res, 401, gatewayErrorPayload("Missing or invalid bearer token.", "invalid_api_key"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleGatewayModelsList(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleGatewayChatCompletions(req, res);
      return;
    }

    // The read surface the browser client is built on. Bearer-checked like
    // every other JSON route — the /app/assets/ exemption is assets only, and
    // this is the route that would make an ambient credential dangerous.
    if (req.method === "POST" && url.pathname === "/v1/bridge") {
      await handleGatewayBridgeRead(req, res);
      return;
    }

    // Loops, read and stop only (docs/ROADMAP.md, watching a run from a phone).
    // There is deliberately NO route that STARTS a run: starting one spends
    // money and takes a permission mode, and the first such route is the one
    // that has to be designed rather than added. Watching and stopping are
    // both safe in the way that matters — one is a read, and the other can
    // only ever reduce what the machine is doing.
    if (req.method === "GET" && url.pathname === "/v1/loops") {
      writeGatewayJson(res, 200, { object: "list", data: await need().listLoops() });
      return;
    }
    const loopMatch = /^\/v1\/loops\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "GET" && loopMatch) {
      const loop = (await need().listLoops()).find((item) => item.id === loopMatch[1]);
      if (!loop) {
        writeGatewayJson(res, 404, gatewayErrorPayload("No such loop.", "not_found"));
        return;
      }
      writeGatewayJson(res, 200, loop);
      return;
    }
    const stopMatch = /^\/v1\/loops\/([\w-]+)\/stop$/.exec(url.pathname);
    if (req.method === "POST" && stopMatch) {
      // Same stopLoop the tray and the panel call, so a phone stop and a
      // desktop stop are the same write through the same serialised mutation.
      const stopped = await need().stopLoop(stopMatch[1], "stopped from a paired device");
      if (!stopped) {
        writeGatewayJson(res, 404, gatewayErrorPayload("No such loop.", "not_found"));
        return;
      }
      writeGatewayJson(res, 200, stopped);
      return;
    }

    // The phone page itself, served BY the gateway so it is same-origin with
    // the routes above. That sidesteps CORS entirely, which matters because
    // the gateway has no CORS handling, no origin check and no rate limiting —
    // a page served from anywhere else would need all three before it could
    // fetch these routes at all.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/loops")) {
      const token = await readOrCreateGatewayToken();
      if (!res.headersSent) res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(gatewayLoopsPage(token));
      return;
    }

    // The desktop renderer, served unchanged. /app WITHOUT the trailing slash
    // has to redirect: the bundle's asset paths are relative (Vite `base:
    // "./"`), so at /app they resolve to /assets/ and every one of them 404s.
    // 301 rather than 308 because this is a GET-only surface and 301 is the one
    // browsers and QR readers cache without asking.
    if (req.method === "GET" && isGatewayAppRedirect(url.pathname)) {
      const query = url.searchParams.toString();
      res.writeHead(301, { location: `${GATEWAY_APP_PREFIX}/${query ? `?${query}` : ""}` });
      res.end();
      return;
    }
    if (req.method === "GET" && isGatewayAppDocument(url.pathname)) {
      const token = await readOrCreateGatewayToken();
      const raw = await readFile(join(need().rendererDist, "index.html"), "utf8").catch(() => null);
      const shell = raw === null ? null : gatewayAppShell(raw, token);
      if (!res.headersSent) res.writeHead(shell ? 200 : 503, { "content-type": "text/html; charset=utf-8" });
      res.end(shell ?? gatewayAppMissingBuildPage());
      return;
    }

    writeGatewayJson(res, 404, gatewayErrorPayload(`Unknown endpoint: ${req.method} ${url.pathname}`, "not_found"));
  } catch (error) {
    writeGatewayJson(res, 500, gatewayErrorPayload(error instanceof Error ? error.message : String(error), "internal_error"));
  }
}

/** Starts the gateway HTTP server bound STRICTLY to 127.0.0.1. Idempotent
 *  (returns the already-running port if called twice) and fail-soft: a bind
 *  failure (e.g. port already in use) is caught, audited, and returned as
 *  `{ ok: false }` — it never throws out of this function or the caller
 *  (app.whenReady / metis-gateway:set-enabled). */
export async function startGateway(): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (gatewayServer) {
    const address = gatewayServer.address() as AddressInfo | null;
    return { ok: true, port: address?.port };
  }
  const configuredPort = await need().readStoreValue<number>("gatewayPort", GATEWAY_DEFAULT_PORT);
  await readOrCreateGatewayToken();

  const server = createServer((req, res) => {
    void handleGatewayRequest(req, res);
  });

  try {
    const boundPort = await new Promise<number>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(configuredPort, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo;
        resolvePromise(address.port);
      });
    });
    gatewayServer = server;
    await need().appendAudit("info", "gateway.start", `Metis Gateway listening on http://127.0.0.1:${boundPort}.`, { port: boundPort });
    return { ok: true, port: boundPort };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await need().appendAudit("warning", "gateway.start.error", `Metis Gateway failed to start: ${message}`, { port: configuredPort, error: message });
    return { ok: false, error: message };
  }
}

/** Stops the gateway server if running. Idempotent and fail-soft — never
 *  throws, safe to call even when the gateway was never started. */
export async function stopGateway(): Promise<void> {
  const server = gatewayServer;
  if (!server) return;
  gatewayServer = null;
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  await need().appendAudit("info", "gateway.stop", "Metis Gateway stopped.", {});
}

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const enabled = await need().readStoreValue<boolean>("gatewayEnabled", false);
  const configuredPort = await need().readStoreValue<number>("gatewayPort", GATEWAY_DEFAULT_PORT);
  const address = gatewayServer ? (gatewayServer.address() as AddressInfo | null) : null;
  const token = await readOrCreateGatewayToken();
  return {
    enabled,
    running: Boolean(gatewayServer),
    port: address?.port ?? configuredPort,
    token
  };
}

/** Live start/stop, wired to a future Settings toggle (DRILL_PLAN P10.1 §1):
 *  persists the flag first (so it survives a restart) and then starts/stops
 *  the server immediately, so the toggle takes effect without relaunching. */
export async function setGatewayEnabled(enabled: boolean): Promise<GatewayStatus> {
  await need().writeStoreValue("gatewayEnabled", enabled);
  if (enabled) {
    await startGateway();
  } else {
    await stopGateway();
  }
  return getGatewayStatus();
}

