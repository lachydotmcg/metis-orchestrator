# Security

A contributor- and user-facing account of Metis Orchestrator's security and
privacy model. Written from the actual code - every claim below traces to a
real file and, where useful, a line number. If something here goes stale,
trust the code and fix this file (see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
for the full process map this document leans on). For the plain-language
privacy summary, see [`docs/PRIVACY.md`](./PRIVACY.md); nothing here should
contradict it.

## Threat model / what Metis protects

Metis Orchestrator is local-first: it has no account system and no servers
of its own. Your conversations, projects, gallery boards, routing policy,
API keys, and permission grants are stored in JSON files under Electron's
`userData` directory (`metis-store/`, see `dataPath()`/`storePath()`,
`main.ts:524-549`), on your own machine.

What that buys you:

- **Your prompts and files stay local unless you route them to a cloud
  provider you configured.** Nothing is sent anywhere by default.
- **Your API keys stay on your device** and are only ever sent to the
  provider they belong to (see "Secrets" below).
- **Nothing is uploaded to us**, because there is nowhere in this
  architecture for it to go.

What it does not protect against: a compromised or malicious OS-level
process on your own machine (Metis runs with your user's OS privileges,
like any desktop app), a leaked API key you paste into a third party, or a
malicious marketplace package you choose to install (see "Third-party
risk"). Metis's job is to not be the thing that leaks your data - it isn't
a sandboxed execution environment for arbitrary untrusted code.

## No telemetry

Verified, not just asserted: `package.json`'s `dependencies` and
`devDependencies` contain no analytics, crash-reporting, or telemetry SDK
(no Segment, Sentry, PostHog, Amplitude, Google Analytics, or similar -
just React, Vite, Electron, and the build toolchain). There is no outbound
call anywhere in `main.ts` that reports usage back to us.

The one place the word "telemetry" appears in the code is a UI label
inside the Lab experiment runner (`main.ts:8168-8172`): a step in a single
local experiment's result view that shows elapsed time, an estimated
output-token count, and a policy-warning count for *that one run*,
computed locally and returned to the renderer - never sent off the
machine. This is exactly the "token and timing numbers shown to you inside
the app" `docs/PRIVACY.md` refers to.

Outbound network calls that do exist are all things you asked for:

- **Your chosen cloud provider**, only when you route a prompt there, and
  only to that provider's own API host - `api.anthropic.com` (`main.ts:1234`),
  `api.openai.com` (`main.ts:1284`), `generativelanguage.googleapis.com`
  (`main.ts:1325`), `api.deepseek.com` (`main.ts:1348`), `openrouter.ai`
  (`main.ts:1372`), `integrate.api.nvidia.com` (`main.ts:1400`), and
  `api.groq.com` (`main.ts:1424`). Local Ollama traffic never leaves the
  machine: `OLLAMA_BASE_URL` is hardcoded to `http://127.0.0.1:11434`
  (`main.ts:8497`).
- **The public community registry**, read-only. `METIS_REGISTRY_BASE_URL`
  (`main.ts:481`) points at
  `https://raw.githubusercontent.com/lachydotmcg/metis-registry/main`; the
  app pulls `index.json`, package manifests, the model catalog, and the
  Community feed from there. These are anonymous GET requests to a public
  repo - no user data rides along.

## Permission model

Every session run resolves to one of five permission modes
(`PermissionMode`, `runtime-contracts.ts:99`):

| Mode | Behavior |
| --- | --- |
| `ask` | Every file write, command, and new network scope pauses for a verdict. |
| `edits` | File writes auto-approved; commands and new scopes still ask. |
| `plan` | Read-only. No writes or commands proceed at all. |
| `auto` | Proceeds, but asks the first time a given scope+target has no existing grant (the default). |
| `bypass` | No prompts, ever. |

`resolvePermissionMode()` (`main.ts:1878`) picks the mode for a run (also
handling back-compat with an older three-level scheme), and every scoped
action funnels through one central function, `gatePermission()`
(`main.ts:1902`), rather than each call site reimplementing the policy.
The scopes it gates are `filesystem.read`, `filesystem.write`,
`network.provider`, `network.web`, `process.spawn`, `mcp.invoke`, and
`notifications.send` (`PermissionScope`, `runtime-contracts.ts:13-20`). In
this codebase today, `filesystem.write`, `network.web`, and `process.spawn`
are the scopes actually gated at real call sites (e.g. `main.ts:3804`,
`3946-4039`); `mcp.invoke` and `notifications.send` are declared in the
type but have no enforcement call site yet - they exist for a feature that
hasn't landed rather than an active gate you can currently test.

When a prompt is needed mid-run, `promptForPermission()` (`main.ts:1552`)
pauses the run and emits a `permission_request` stream event to the
renderer, which shows the in-run popup with three buttons - **Allow**
(once), **Always**, and **Deny** (`App.tsx:5929-5935`). Two properties
worth calling out because they're fail-closed by design:

- If there's no active stream to prompt on, the request auto-denies
  immediately (`main.ts:1558`).
- If nobody answers within 5 minutes, it also auto-denies
  (`PERMISSION_PROMPT_TIMEOUT_MS = 5 * 60 * 1000`, `main.ts:1549`,
  timeout handling `main.ts:1563-1566`).

An "Always" verdict writes a `PermissionGrant` (`runtime-contracts.ts:69-81`)
to the `permissions` store via `requestPermission()` (`main.ts:1631`), so
future asks for that exact scope+target(+project path) are skipped under
`auto` mode. Grants can be listed and individually revoked through the
`metisPermissions` bridge (`list`/`revoke`, `preload.cts:124,126`).

File reads/writes reachable from the Graph View document viewer go through
an additional, independent guard - `assertMetisFilePathAllowed()`
(`main.ts:1951`) - that checks the resolved path sits inside either the
currently-granted project workspace or a granted project resource before
touching disk at all, regardless of permission mode. The write path
(`writeMetisFile`) reuses the exact same check as the read path, so it can
never be looser.

## The Electron trust boundary

Standard three-process split (full detail in
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md#process-model)):

- **Main** (`src/electron/main.ts`) runs in Node with full OS access -
  filesystem, `child_process`, `safeStorage`, all outbound network calls.
- **Renderer** (`src/renderer/ui/App.tsx`) is treated as untrusted UI. It
  can only reach main through the typed `window.metisXxx` calls; main
  re-checks security-relevant flags itself rather than trusting the
  renderer to have gated a call correctly.
- **Preload** (`src/electron/preload.cts`) is the only bridge between the
  two. Every capability the renderer can use is an explicit
  `contextBridge.exposeInMainWorld("metisXxx", { ... })` block wrapping
  `ipcRenderer.invoke`/`.send`/`.on` - there is no other path from
  renderer JS into Node or the OS.

The app's main `BrowserWindow` (`createWindow()`, `main.ts:9573`) sets
`contextIsolation: true` and `nodeIntegration: false` in its
`webPreferences` (`main.ts:9586-9587`), with `preload.cjs` (compiled from
`preload.cts`) as its only preload script. `sandbox` is not explicitly set
on this window, so Electron's own default for that setting applies.
Separately, a hidden, non-UI `BrowserWindow` used only for internal build
verification - `verifyPreviewInBrowser()` (`main.ts:4181`), which loads a
generated project's local preview URL headlessly to check for console
errors - does explicitly set `sandbox: true` (`main.ts:4187-4190`) and has
no preload script at all.

## The Metis Gateway

Metis can optionally expose an OpenAI-compatible HTTP API so other local
software (scripts, editors, third-party tools) can send it prompts. It's
**off by default** (the `gatewayEnabled` store flag, default `false`) and
only starts listening once you turn it on.

- **Loopback-only.** The server binds strictly to `127.0.0.1`, never
  `0.0.0.0` (`startGateway()`, `main.ts:10246`) - nothing outside your
  machine can reach it, regardless of your firewall configuration.
- **Bearer-token gated.** Every request needs
  `Authorization: Bearer <gatewayToken>`, an auto-generated per-install
  token persisted locally (`readOrCreateGatewayToken()`) and checked with a
  constant-time `timingSafeEqual` comparison
  (`gatewayTokenMatches()`, `main.ts:9977`). Being bound to loopback does not
  by itself stop other processes on the same machine from reaching a
  listening port - the token is what stops other local software from
  silently using the Gateway as an open prompt-proxy.
- **No prompt content in the audit trail.** The Gateway's audit line
  (`gateway.request`, `main.ts:10205`) records only the resolved model id,
  request timing, and ok/error status - never the prompt or message
  content, consistent with the rest of the audit log.
- **No new capability beyond a model call.** A Gateway request either runs
  the same Auto Router decision (`decidePolicy` +
  `applySessionRouteOverrides`) a chat composer turn would, or calls a
  pinned model directly - it does not reach the build pipeline, filesystem
  writes, or MCP tool calls.

## Secrets

Provider API keys are stored locally, one "classic" key per provider (plus
an optional multi-account pool for the "Never Run Dry" feature), via
`setSecret()`/`readSecrets()`/`writeSecrets()` (`main.ts:595-674`). On
save, `encryptSecret()` (`main.ts:603-617`) picks the strongest storage
available at the OS level:

- If `safeStorage.isEncryptionAvailable()` is true (OS keychain/DPAPI-backed
  encryption is available), the key is encrypted with Electron's
  `safeStorage` and stored as base64 (`storage: "safeStorage"`).
- Otherwise it falls back to a plain base64 encoding on disk
  (`storage: "plain-local"`) - **not encryption**, just avoiding storing
  the raw string verbatim. This only happens on systems where OS-level
  secure storage isn't available.
- A key can also come from an environment variable at read time
  (`storage: "environment"`, resolved in `secretStatus()`/
  `readProviderSecret()`, `main.ts:645-660` and `799-811`) - useful for
  dev/CI, and this path is never written back to disk by the app.

`SecretStatus.storage` (`runtime-contracts.ts:24-29`) is exactly these four
values (`"safeStorage" | "plain-local" | "environment" | "none"`), and the
Settings UI is expected to show you which one is active per provider - be
honest with yourself that `"plain-local"` is weaker than `"safeStorage"` if
you see it.

Regardless of storage tier, a key is only ever read back and sent to the
one matching provider's API host inside `invokeCloudProvider()`
(`main.ts:1207`) - never logged, never included in the audit log (which
records the storage tier on save, not the key value - `main.ts:638-641`),
and never sent to any provider other than the one it belongs to.

## Third-party risk

Metis has a community package registry (marketplace skills, MCP server
definitions, presets). Two things worth knowing before you install
something from it:

- **Installing an MCP package spawns a real child process on your
  machine.** `probeMcpServer()` (`main.ts:2490`) reads the package's
  `mcp.json`, then `spawn()`s its configured `command`/`args`/`env`
  directly (`main.ts:2523-2529`), on a 20-second timeout
  (`main.ts:2538-2540`). Any MCP server you install (and any skill you run)
  executes with your OS user's own privileges - Metis does not sandbox
  package code. Only install from sources you trust, the same way you
  would for any other executable.
- **Package install auto-grants the permission scopes the package
  declares**, without an interactive per-scope prompt at install time.
  `installPackage()` (`main.ts:2302`) verifies the downloaded payload's
  SHA-256 against the registry manifest and refuses to install on a
  mismatch (`main.ts:2313-2320`), but it then loops over the package's
  `permissions_requested` and calls `requestPermission()` for each one
  directly (`main.ts:2328-2335`), writing real `PermissionGrant`s. Read
  what a package asks for before installing it; uninstalling later revokes
  grants sourced from that package (matched via `sourcePackageId`,
  `main.ts:2359-2363`).

Prompts you send to a cloud provider (Anthropic, OpenAI, Google, DeepSeek,
Groq, NVIDIA, OpenRouter) are governed by that provider's own privacy
policy and terms once they leave your machine, not by Metis - see
[`docs/PRIVACY.md`](./PRIVACY.md).

## The audit log

Every notable security-relevant action - permission grants, secret
set/delete, package installs and SHA-256 mismatches, MCP probes - calls
`appendAudit(level, kind, summary, metadata?)` (`main.ts:560`), which
appends one JSON line to `metis-store/audit-log.jsonl` under your local
`userData` directory. `listAudit(limit)` (`main.ts:575`) reads the most
recent entries back for the in-app Audit view via the `metisAudit.list`
bridge. This is a local record for your own visibility into what the app
did and when - it is not transmitted anywhere, and it is not a substitute
for OS-level logging or a tamper-evident ledger.

## Reporting a vulnerability

If you find a security issue in Metis Orchestrator, please report it
privately rather than opening a public issue: **lachyswebdev@gmail.com**.
Include what you found, the steps to reproduce it, and its impact if you
can. We'll acknowledge reports and work with you on a fix before any
public disclosure - please give us a reasonable window to respond before
sharing details elsewhere.

---

Last updated: 2026-07-14.
