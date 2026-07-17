# Metis as an MCP server

DRILL_PLAN.md B12.5. This is the inverse of the MCP client Metis already ships
(Metis spawning third-party MCP servers to use their tools, see the MCP panel
in Settings). Here, Metis itself is exposed as a tool provider: any MCP
client (Claude Code, Cursor, or anything else that speaks MCP over stdio) can
run `scripts/metis-mcp.mjs` and get three tools backed by Metis' own routing.

## What it is

`scripts/metis-mcp.mjs` is a small, dependency-free Node script. It does not
talk to Metis' policy engine directly. It forwards every tool call as an HTTP
request to the Metis Gateway, the loopback OpenAI-compatible API Metis
already runs at `http://127.0.0.1:11500` (Settings > Gateway). So Metis needs
to actually be running with the Gateway turned on for these tools to do
anything.

Client <-> (stdio, MCP JSON-RPC) <-> metis-mcp.mjs <-> (HTTP) <-> Metis Gateway <-> Metis Policy / providers

## Setup

1. Open Metis, go to Settings > Gateway, turn the Gateway on if it isn't
   already, and copy the bearer token shown there.
2. In your MCP client's config, point it at this script with the token as an
   env var. Example (Claude Code style `mcpServers` config):

```json
{
  "mcpServers": {
    "metis": {
      "command": "node",
      "args": ["C:/Users/you/path/to/metis-orchestrator/scripts/metis-mcp.mjs"],
      "env": {
        "METIS_GATEWAY_TOKEN": "paste-the-token-from-settings-here"
      }
    }
  }
}
```

Use an absolute path to `scripts/metis-mcp.mjs` — MCP clients spawn the
command from their own working directory, not this repo.

If the Gateway is running on a non-default port or host, also set
`METIS_GATEWAY_URL` (default `http://127.0.0.1:11500`).

## Tools

- **metis_route** — `{ prompt: string }`. Sends the prompt to the Gateway
  with model `metis-auto` (the Auto Router sentinel), so Metis Policy picks
  the best local or cloud model for it. Returns the assistant's text.
- **metis_ask_model** — `{ model: string, prompt: string }`. Same as above
  but pins a specific model id instead of letting the router decide. Use
  `metis_models` to see valid ids.
- **metis_models** — `{}`. Lists the model ids the Gateway currently reports
  (the `metis-auto` sentinel plus every installed Ollama model), one per
  line.

## Errors

Every failure comes back as a normal MCP tool result with `isError: true`
and a plain-text explanation, never a crash:

- Metis not running or the Gateway toggled off -> "Could not reach the Metis
  Gateway..." (connection refused).
- Wrong or missing token -> "Metis Gateway rejected the request: missing or
  invalid bearer token..." Check `METIS_GATEWAY_TOKEN` against Settings >
  Gateway.
- Anything else the Gateway itself returns as an error (bad model id,
  provider failure) is passed through with its message.

If `METIS_GATEWAY_TOKEN` isn't set at all when the script starts, it exits
immediately with a message on stderr rather than starting a server that can
never authenticate.

## Protocol notes

The script speaks newline-delimited JSON-RPC 2.0 over stdio (one JSON object
per line, no `Content-Length` framing), matching the framing Metis' own MCP
client (`McpStdioClient` in `src/electron/main.ts`) uses when it drives
third-party MCP servers. It implements `initialize`, ignores
`notifications/initialized`, and implements `tools/list` and `tools/call`.
Anything else gets a standard JSON-RPC "method not found" error.
