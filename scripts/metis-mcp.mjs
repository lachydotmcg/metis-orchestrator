#!/usr/bin/env node
// Metis-as-MCP-server bridge (docs/DRILL_PLAN.md B12.5).
//
// This is the INVERSE of the MCP client Metis already ships (McpStdioClient
// in src/electron/main.ts, which spawns third-party MCP servers and drives
// them over stdio). Here Metis itself is exposed as a standalone MCP server:
// any MCP client (Claude Code, Cursor, etc.) can spawn this script over
// stdio and get three tools that forward to the already-running Metis
// Gateway (the loopback OpenAI-compatible HTTP API started by startGateway()
// in src/electron/main.ts, default http://127.0.0.1:11500).
//
// Zero dependencies, plain Node ESM. The JSON-RPC framing below mirrors
// McpStdioClient exactly: newline-delimited JSON objects, `{jsonrpc, id,
// method, params}` requests, `{jsonrpc, id, result|error}` responses,
// `{jsonrpc, method, params}` notifications (no id, no reply expected).
//
// Config (env vars):
//   METIS_GATEWAY_URL   - base URL of the Metis Gateway (default http://127.0.0.1:11500)
//   METIS_GATEWAY_TOKEN - bearer token for the Gateway (required; see docs/MCP_SERVER.md
//                         for where to find it in Metis' Settings > Gateway panel)

import { createInterface } from "node:readline";

const GATEWAY_URL = (process.env.METIS_GATEWAY_URL || "http://127.0.0.1:11500").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.METIS_GATEWAY_TOKEN || "";

if (!GATEWAY_TOKEN) {
  process.stderr.write(
    "metis-mcp: METIS_GATEWAY_TOKEN is not set. Find the token in Metis under " +
      "Settings > Gateway, then set it in your MCP client's env config for this " +
      "server. Exiting.\n"
  );
  process.exit(1);
}

const SERVER_INFO = { name: "metis", version: "0.1.0" };
// Protocol version this server was built/tested against. initialize() below
// echoes back whatever the connecting client asked for instead of forcing
// this value, since MCP clients negotiate on the client-sent version.
const KNOWN_PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------
// Gateway HTTP calls
// ---------------------------------------------------------------------------

/** Describes a fetch()/network-level failure in the same actionable-text
 *  shape a Gateway HTTP error would produce, so tool handlers can treat both
 *  uniformly. Never throws. */
function describeFetchError(error) {
  const code = error && typeof error === "object" ? error.cause?.code || error.code : undefined;
  if (code === "ECONNREFUSED") {
    return `Could not reach the Metis Gateway at ${GATEWAY_URL}. Metis is probably not running, or the Gateway is turned off (Settings > Gateway > Enable Gateway).`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Could not resolve the Gateway host for ${GATEWAY_URL}. Check METIS_GATEWAY_URL.`;
  }
  return `Failed to reach the Metis Gateway at ${GATEWAY_URL}: ${error instanceof Error ? error.message : String(error)}`;
}

/** POST/GET against the Gateway. Returns { ok: true, data } on a 2xx JSON
 *  response, or { ok: false, text } with an actionable message on any
 *  failure (network error, non-2xx, malformed JSON) — this function never
 *  throws so tool handlers can turn { ok: false } straight into an isError
 *  MCP result. */
async function gatewayFetch(path, init) {
  let response;
  try {
    response = await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        ...(init && init.body ? { "content-type": "application/json" } : {}),
        ...(init && init.headers)
      }
    });
  } catch (error) {
    return { ok: false, text: describeFetchError(error) };
  }

  let payload;
  const raw = await response.text().catch(() => "");
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = undefined;
  }

  if (response.status === 401) {
    return { ok: false, text: "Metis Gateway rejected the request: missing or invalid bearer token. Check METIS_GATEWAY_TOKEN against Settings > Gateway in Metis." };
  }
  if (!response.ok) {
    const message = payload?.error?.message || raw || `HTTP ${response.status}`;
    return { ok: false, text: `Metis Gateway returned an error (${response.status}): ${message}` };
  }
  if (payload === undefined) {
    return { ok: false, text: "Metis Gateway returned a response that was not valid JSON." };
  }
  return { ok: true, data: payload };
}

/** Shared chat-completions call for metis_route and metis_ask_model. `model`
 *  is the Gateway's Auto Router sentinel "metis-auto" for metis_route, or a
 *  pinned model id for metis_ask_model — same /v1/chat/completions endpoint
 *  either way (see resolveGatewayRoute in src/electron/main.ts). */
async function gatewayChat(model, prompt) {
  const result = await gatewayFetch("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false
    })
  });
  if (!result.ok) return result;
  const text = result.data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    return { ok: false, text: "Metis Gateway response had no assistant message content." };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "metis_route",
    description:
      "Routes a prompt through Metis Policy to whichever local or cloud model it decides is best (the Auto Router), and returns that model's answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to route and answer." }
      },
      required: ["prompt"]
    },
    handler: async (args) => {
      const prompt = typeof args?.prompt === "string" ? args.prompt : "";
      if (!prompt.trim()) return { ok: false, text: "`prompt` is required and must be a non-empty string." };
      return gatewayChat("metis-auto", prompt);
    }
  },
  {
    name: "metis_ask_model",
    description: "Sends a prompt to a specific model (by id, e.g. an installed Ollama model name) via Metis, bypassing the Auto Router, and returns its answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model id to target, as reported by metis_models." },
        prompt: { type: "string", description: "The prompt to send." }
      },
      required: ["model", "prompt"]
    },
    handler: async (args) => {
      const model = typeof args?.model === "string" ? args.model : "";
      const prompt = typeof args?.prompt === "string" ? args.prompt : "";
      if (!model.trim()) return { ok: false, text: "`model` is required and must be a non-empty string." };
      if (!prompt.trim()) return { ok: false, text: "`prompt` is required and must be a non-empty string." };
      return gatewayChat(model, prompt);
    }
  },
  {
    name: "metis_models",
    description: "Lists the model ids Metis currently has available (the Auto Router sentinel plus every installed Ollama model).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await gatewayFetch("/v1/models", { method: "GET" });
      if (!result.ok) return result;
      const ids = Array.isArray(result.data?.data) ? result.data.data.map((entry) => entry?.id).filter((id) => typeof id === "string") : [];
      if (ids.length === 0) return { ok: false, text: "Metis Gateway returned no models." };
      return { ok: true, text: ids.join("\n") };
    }
  }
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (newline-delimited), mirroring McpStdioClient's framing
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(id, method, params) {
  if (method === "initialize") {
    const requestedVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : KNOWN_PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    });
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = typeof toolName === "string" ? TOOLS_BY_NAME.get(toolName) : undefined;
    if (!tool) {
      sendError(id, -32602, `Unknown tool: ${JSON.stringify(toolName)}`);
      return;
    }
    try {
      const outcome = await tool.handler(params?.arguments || {});
      sendResult(id, {
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.ok ? {} : { isError: true })
      });
    } catch (error) {
      sendResult(id, {
        content: [{ type: "text", text: `metis_mcp: unexpected error running ${tool.name}: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true
      });
    }
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

function handleNotification(method) {
  // notifications/initialized and any other notification: nothing to do,
  // no reply expected (no id on the incoming message).
  void method;
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Non-JSON line on stdin — ignore rather than crash the server.
    return;
  }
  const hasId = typeof message?.id === "number" || typeof message?.id === "string";
  if (hasId) {
    void handleRequest(message.id, message.method, message.params);
  } else {
    handleNotification(message.method);
  }
});

process.stdin.on("end", () => process.exit(0));
