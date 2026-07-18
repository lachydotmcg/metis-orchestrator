/**
 * Headless CLI mode for Metis Orchestrator.
 *
 * Lets an engineer (or CI) exercise the REAL session pipeline — the exact
 * same runSessionTracked() the renderer calls over IPC for a normal chat
 * send — without opening any window, without a human to click through
 * folder pickers or permission prompts, and with output an engineer or a
 * script can actually read and assert on.
 *
 * Design notes:
 *  - This file never touches the `electron` module directly. Every piece of
 *    real app behaviour it needs (running a session, establishing a project
 *    workspace, reading the store, checking Ollama, resolving permission
 *    prompts) is INJECTED from main.ts as a plain object (CliRuntime) built
 *    from the exact same in-scope functions the ipcMain handlers call. CLI
 *    mode never reimplements pipeline behaviour, it only decides what to
 *    call and how to print the result — so "the CLI passed" and "the app
 *    works" mean the same thing. It also means this module has zero
 *    Electron-specific side effects at import time and is trivially
 *    unit-testable with a mocked CliRuntime.
 *  - Permissions: every CLI run uses permissionMode "auto" (see the
 *    runCliMode doc comment below for why this can't be a flag). "auto"
 *    still asks once per in-run write/command via a `permission_request`
 *    stream event when no persisted grant matches that exact target yet
 *    (see gatePermission/hasExistingGrant in main.ts) — normally a human
 *    clicks Allow in the renderer. There is no human in CLI mode, so this
 *    file answers those prompts itself, immediately, with "allow" (never
 *    "always" — nothing new is persisted to the permissions store beyond
 *    the one explicit workspace grant `--project` creates), and answers any
 *    <ask_user> question with its first offered option. Every auto-decision
 *    is printed as it happens so the transcript stays honest about what the
 *    CLI decided on the user's behalf and why.
 */

import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type {
  AgentOperation,
  OllamaListResult,
  OrchestrationStage,
  PermissionVerdict,
  PolicyStatus,
  ProjectToolResult,
  ProjectWorkspace,
  ProviderKey,
  SecretStatus,
  SessionModelOverride,
  SessionRun,
  SessionRunInput,
  SessionStreamEvent,
  SessionTimelineEvent,
  UserQuestionAnswer
} from "../shared/runtime-contracts.js";

/** Structural twin of main.ts's private `SessionStreamController` type
 *  ({ emit(event) => void }). main.ts never exports that type — it doesn't
 *  need to, because TypeScript matches it by shape, not by name. Passing an
 *  object built from this type into the injected runSessionTracked works
 *  exactly as if it were main.ts's own type. */
export type CliStreamEmitter = { emit: (event: SessionStreamEvent) => void };

/** Everything runCliMode needs FROM the real app. Every function here is a
 *  direct reference to the same function main.ts's ipcMain handlers call —
 *  built once, at the single `--cli` call site in main.ts's app.whenReady()
 *  branch. See the module doc comment above for why this is injected rather
 *  than imported. */
export interface CliRuntime {
  runSessionTracked(input: SessionRunInput, stream?: CliStreamEmitter): Promise<SessionRun>;
  establishWritableWorkspace(path: string): Promise<ProjectWorkspace>;
  readProjectWorkspace(): Promise<ProjectWorkspace | null>;
  respondToPermissionPrompt(id: string, verdict: PermissionVerdict): void;
  respondToUserQuestion(id: string, answer: UserQuestionAnswer): void;
  requestSessionCancel(projectPath?: string): void;
  readStoreValue<T>(key: string, fallback: T): Promise<T>;
  listOllamaModels(): Promise<OllamaListResult>;
  listSecrets(): Promise<SecretStatus[]>;
  getPolicyStatus(profilePath?: string): Promise<PolicyStatus>;
  providerInfo: Readonly<Record<ProviderKey, { label: string; defaultModel?: string }>>;
  /** app.getPath("userData") — where metis-store/*.json actually lives. */
  userDataPath: string;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

/** Every boolean feature-flag store key read anywhere in main.ts, with the
 *  same fallback each call site uses. Kept as an explicit list (rather than
 *  discovered at runtime) so `doctor` reports a flag as "off" when it has
 *  never been set, same as the app itself does — a store with zero keys and
 *  a store with every flag explicitly set to its default report identically,
 *  which is the whole point of a documented default. */
const FEATURE_FLAGS: ReadonlyArray<{ key: string; label: string; default: boolean }> = [
  { key: "knowledgeBankEnabled", label: "Knowledge bank", default: true },
  { key: "fanoutEnabled", label: "Multi-agent fan-out", default: false },
  { key: "prewarmEnabled", label: "Speculative prewarm (Oracle)", default: false },
  { key: "oracleCloudEnabled", label: "Oracle cloud draft", default: false },
  { key: "oracleSimilarityEnabled", label: "Oracle similarity serve", default: false },
  { key: "modelDrivenRoutingEnabled", label: "Model-driven routing", default: false },
  { key: "depthRoutingEnabled", label: "Depth routing", default: false },
  { key: "mcpToolsEnabled", label: "MCP tools", default: false },
  { key: "routinesPaused", label: "Background routines paused", default: false },
  { key: "gatewayEnabled", label: "Metis Gateway (local API server)", default: false },
  { key: "headlessStart", label: "Headless start (P10.5, GUI mode only)", default: false },
  { key: "quickAskEnabled", label: "Quick-ask global hotkey", default: false },
  { key: "closeToTray", label: "Close to tray", default: false }
];

class CliUsageError extends Error {}

interface ParsedArgs {
  subcommand: "chat" | "build" | "doctor" | "help";
  prompt?: string;
  projectPath?: string;
  model?: string;
  json: boolean;
  timeoutSeconds: number;
}

function usageText(): string {
  return [
    "Metis Orchestrator - headless CLI mode",
    "",
    "Usage:",
    '  npm run cli -- doctor [--json]',
    '  npm run cli -- chat "<prompt>" [--project <path>] [--model <provider/model>] [--json] [--timeout <seconds>]',
    '  npm run cli -- build "<prompt>" --project <path> [--model <provider/model>] [--json] [--timeout <seconds>]',
    "",
    "Flags:",
    "  --project <path>          Establishes <path> as the writable project workspace for this run",
    "                             (same grant selectProjectWorkspace's \"Choose folder\" writes). Created",
    "                             on disk first if it doesn't exist yet. Without it, build writes into",
    "                             Metis's own app-managed workspace folder instead of a real project.",
    "  --model <provider/model>  Pins a model instead of Auto Router, e.g. ollama/qwen3:8b or",
    "                             anthropic/claude-sonnet-5. Maps onto SessionRunInput.modelOverride.",
    "  --json                    Print one machine-readable JSON blob instead of the human stream —",
    "                             the SessionRun object for chat/build, the report object for doctor —",
    "                             and nothing else to stdout, for assertions in tests.",
    "  --timeout <seconds>       Overall wall-clock budget before the run is cancelled and the process",
    "                             exits non-zero. Default 300.",
    "",
    'Permissions: every run uses permissionMode "auto" — there is no human in CLI mode to answer a',
    "permission prompt or an <ask_user> question, so both are auto-resolved the instant they fire",
    "(permission prompts: allowed for this run only, nothing new is persisted beyond the workspace",
    "grant --project itself creates; questions: answered with their first offered option) and printed",
    "as they happen instead of silently blocking for 5 minutes and then defaulting.",
    "",
    "Exit codes:",
    "  0    success - a real provider answered (chat) or the build wrote and verified cleanly (build),",
    "       or doctor ran.",
    "  1    the run threw (unexpected internal error).",
    "  2    CLI usage error (bad flags/arguments) - nothing was run.",
    "  3    the run completed but did not get a real answer - e.g. Ollama unreachable and no cloud key",
    "       configured, every build stage failed, or build verification failed. See stderr / warnings",
    "       for the honest reason.",
    "  124  timed out (see --timeout)."
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const cliIndex = argv.indexOf("--cli");
  const rest = cliIndex >= 0 ? argv.slice(cliIndex + 1) : argv.slice();

  let json = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let projectPath: string | undefined;
  let model: string | undefined;
  let helpRequested = false;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      helpRequested = true;
      continue;
    }
    if (token === "--project") {
      const value = rest[++i];
      if (!value) throw new CliUsageError("--project requires a path argument.");
      projectPath = value;
      continue;
    }
    if (token === "--model") {
      const value = rest[++i];
      if (!value) throw new CliUsageError("--model requires a provider/model argument, e.g. ollama/qwen3:8b.");
      model = value;
      continue;
    }
    if (token === "--timeout") {
      const value = rest[++i];
      const parsedSeconds = value ? Number(value) : NaN;
      if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
        throw new CliUsageError(`--timeout requires a positive number of seconds, got "${value ?? ""}".`);
      }
      timeoutSeconds = parsedSeconds;
      continue;
    }
    if (token.startsWith("--")) {
      throw new CliUsageError(`Unknown flag: ${token}`);
    }
    positionals.push(token);
  }

  if (helpRequested) {
    return { subcommand: "help", json, timeoutSeconds };
  }

  const subcommand = positionals.shift();
  if (!subcommand) throw new CliUsageError("Missing subcommand. Expected one of: chat, build, doctor.");
  if (subcommand !== "chat" && subcommand !== "build" && subcommand !== "doctor") {
    throw new CliUsageError(`Unknown subcommand "${subcommand}". Expected one of: chat, build, doctor.`);
  }

  let prompt: string | undefined;
  if (subcommand === "chat" || subcommand === "build") {
    prompt = positionals.shift();
    if (!prompt || !prompt.trim()) {
      throw new CliUsageError(`"${subcommand}" requires a prompt argument, e.g. npm run cli -- ${subcommand} "hello"`);
    }
  }

  if (positionals.length > 0) {
    throw new CliUsageError(`Unexpected extra argument(s): ${positionals.join(" ")}`);
  }

  return { subcommand, prompt, projectPath, model, json, timeoutSeconds };
}

function parseModelOverride(raw: string, providerInfo: CliRuntime["providerInfo"]): SessionModelOverride {
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    throw new CliUsageError(`--model must be formatted as provider/model (e.g. ollama/qwen3:8b), got "${raw}".`);
  }
  const provider = raw.slice(0, slash).toLowerCase();
  const model = raw.slice(slash + 1);
  if (!(provider in providerInfo)) {
    throw new CliUsageError(`--model has an unknown provider "${provider}". Known providers: ${Object.keys(providerInfo).join(", ")}.`);
  }
  return { provider: provider as ProviderKey, model };
}

function out(line: string): void {
  console.log(line);
}

function errout(line: string): void {
  console.error(line);
}

function truncate(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

// --- Human-readable rendering of a live SessionStreamEvent ---------------

function describeTimelineEvent(event: SessionTimelineEvent): string {
  switch (event.kind) {
    case "text":
      return event.content;
    case "route":
      return `[route] ${event.label ?? "Auto Router"}${event.pipelineName ? ` - ${event.pipelineName}` : ""}`;
    case "stage":
      return `[stage] starting: ${event.stageId}`;
    case "operations":
      return `[operations] ${event.title}${event.detail ? `: ${event.detail}` : ""}`;
    default:
      return JSON.stringify(event);
  }
}

function describeOperation(op: AgentOperation): string {
  const bits = [`[op:${op.status.toUpperCase()}] ${op.kind} - ${op.label}`];
  if (op.target) bits.push(`target=${op.target}`);
  if (typeof op.exitCode === "number") bits.push(`exitCode=${op.exitCode}`);
  if (typeof op.addedLines === "number" || typeof op.removedLines === "number") {
    bits.push(`+${op.addedLines ?? 0}/-${op.removedLines ?? 0}`);
  }
  if (typeof op.durationMs === "number") bits.push(`${op.durationMs}ms`);
  let line = bits.join(" ");
  if (op.kind === "command" && op.status === "error" && op.stderr) {
    line += `\n  stderr: ${truncate(op.stderr, 200)}`;
  }
  return line;
}

function describeStage(stage: OrchestrationStage): string {
  const head = `[stage:${stage.failed ? "FAILED" : "done"}] ${stage.label} via ${stage.provider}/${stage.model}${
    stage.criticPasses ? ` (${stage.criticPasses} critic pass${stage.criticPasses === 1 ? "" : "es"})` : ""
  }`;
  const notes = stage.fallbackNotes.length ? `\n  fallback: ${stage.fallbackNotes.map((note) => truncate(note, 120)).join(" | ")}` : "";
  const preview = stage.output ? `\n  -> ${truncate(stage.output)}` : "";
  return `${head}${notes}${preview}`;
}

function describeProject(project: ProjectToolResult): string {
  const lines = [
    `[project] root=${project.projectRoot} mode=${project.writeMode} verified=${project.verified ? "yes" : "no"} - ${project.verificationDetail}`
  ];
  for (const artifact of project.artifacts) {
    const bits = [`  - ${artifact.kind}: ${artifact.label}`];
    if (artifact.path) bits.push(`(${artifact.path})`);
    if (typeof artifact.bytes === "number") bits.push(`${artifact.bytes}B`);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}

function createLinePrinter(json: boolean) {
  let mode: "idle" | "message" | "thought" = "idle";
  let sawMessageDelta = false;

  function breakIfNeeded(): void {
    if (mode !== "idle") {
      process.stdout.write("\n");
      mode = "idle";
    }
  }

  return {
    get sawMessageDelta(): boolean {
      return sawMessageDelta;
    },
    line(text: string): void {
      if (json) return;
      breakIfNeeded();
      out(text);
    },
    messageDelta(delta: string): void {
      if (json) return;
      sawMessageDelta = true;
      if (mode !== "message") {
        breakIfNeeded();
        process.stdout.write("\nAssistant: ");
        mode = "message";
      }
      process.stdout.write(delta);
    },
    thoughtDelta(delta: string): void {
      if (json) return;
      if (mode !== "thought") {
        breakIfNeeded();
        process.stdout.write("\nThinking:  ");
        mode = "thought";
      }
      process.stdout.write(delta);
    },
    finish(): void {
      if (json) return;
      breakIfNeeded();
    }
  };
}

function buildStream(deps: CliRuntime, printer: ReturnType<typeof createLinePrinter>): CliStreamEmitter {
  return {
    emit(streamEvent: SessionStreamEvent): void {
      switch (streamEvent.kind) {
        case "timeline":
          printer.line(describeTimelineEvent(streamEvent.event));
          break;
        case "message_delta":
          printer.messageDelta(streamEvent.delta);
          break;
        case "thought_delta":
          printer.thoughtDelta(streamEvent.delta);
          break;
        case "step":
          printer.line(`[step:${streamEvent.step.status}] ${streamEvent.step.label} - ${streamEvent.step.detail}`);
          break;
        case "stage":
          printer.line(describeStage(streamEvent.stage));
          break;
        case "operation":
          printer.line(describeOperation(streamEvent.operation));
          break;
        case "project":
          printer.line(describeProject(streamEvent.project));
          break;
        case "stage_call": {
          const call = streamEvent.call;
          const head = `[call:${call.status}] ${call.stageLabel} via ${call.provider}/${call.model}${call.agentName ? ` (${call.agentName})` : ""}${
            call.detail ? ` - ${call.detail}` : ""
          }`;
          const body = call.status === "start" ? `\n  prompt: ${truncate(call.promptPreview, 140)}` : call.output ? `\n  output: ${truncate(call.output, 140)}` : "";
          printer.line(`${head}${body}`);
          break;
        }
        case "permission_request": {
          const { id, scope, target, detail } = streamEvent.request;
          printer.line(`[permission] ${scope} on "${target}" - ${detail} -> auto-approved (CLI permissionMode "auto", no human available)`);
          deps.respondToPermissionPrompt(id, "allow");
          break;
        }
        case "user_question": {
          const { id, text, options, questions } = streamEvent.question;
          if (questions && questions.length > 0) {
            const answers = questions.map((q) => q.options[0] ?? "(no preference given - use your best judgement)");
            printer.line(
              `[question] ${questions.length} question(s) asked -> auto-answered with the first option each (CLI auto mode): ${questions
                .map((q, i) => `"${q.text}" = "${answers[i]}"`)
                .join("; ")}`
            );
            deps.respondToUserQuestion(id, answers);
          } else {
            const answer = options[0] ?? "(no preference given - use your best judgement)";
            printer.line(`[question] "${text}" -> auto-answered "${answer}" (CLI auto mode, first option)`);
            deps.respondToUserQuestion(id, answer);
          }
          break;
        }
        case "error":
          printer.finish();
          errout(`[error] ${streamEvent.message}`);
          break;
        case "complete":
          printer.line(`[done] pipeline=${streamEvent.run.pipelineName}`);
          break;
        default:
          break;
      }
    }
  };
}

// --- doctor ----------------------------------------------------------------

async function runDoctor(deps: CliRuntime, json: boolean): Promise<number> {
  const [ollama, secrets, workspace, policy, selfVerify] = await Promise.all([
    deps.listOllamaModels(),
    deps.listSecrets(),
    deps.readProjectWorkspace(),
    deps.getPolicyStatus().catch(
      (error): PolicyStatus => ({
        available: false,
        detail: `getPolicyStatus threw: ${error instanceof Error ? error.message : String(error)}`
      })
    ),
    deps.readStoreValue<"off" | "local" | "all">("selfVerify", "local")
  ]);

  const flagValues: Record<string, boolean> = {};
  for (const flag of FEATURE_FLAGS) {
    flagValues[flag.key] = await deps.readStoreValue(flag.key, flag.default);
  }

  const providerKeys = secrets.filter((status) => status.provider !== "ollama");

  const report = {
    ollama: { reachable: ollama.reachable, installedModels: ollama.installed },
    providerKeys: providerKeys.map((status) => ({
      provider: status.provider,
      label: deps.providerInfo[status.provider]?.label ?? status.provider,
      configured: status.hasSecret,
      source: status.storage
    })),
    projectWorkspace: workspace,
    routingEngine: policy,
    featureFlags: FEATURE_FLAGS.map((flag) => ({ key: flag.key, label: flag.label, enabled: flagValues[flag.key], default: flag.default })),
    selfVerifyPolicy: selfVerify,
    userDataPath: deps.userDataPath
  };

  if (json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }

  out("Metis Orchestrator - environment doctor");
  out("========================================");
  out("(read-only - nothing below was run or written)");
  out("");
  out(`Ollama:  ${ollama.reachable ? "reachable" : "NOT reachable"} at http://127.0.0.1:11434`);
  if (ollama.reachable) {
    out(ollama.installed.length ? `  Pulled models: ${ollama.installed.join(", ")}` : "  Pulled models: (none - `ollama pull <model>` first)");
  } else {
    out("  Start Ollama (or the Ollama app) so local-model runs have something to talk to.");
  }
  out("");
  out("Provider API keys (names only - values are never read or printed):");
  for (const status of providerKeys) {
    const label = deps.providerInfo[status.provider]?.label ?? status.provider;
    out(`  ${label.padEnd(16)} ${status.hasSecret ? `configured (${status.storage})` : "not configured"}`);
  }
  out("");
  out("Routing engine (metis-policy CLI):");
  out(`  ${policy.available ? "available" : "NOT available - decisions fall back to a static sample"} - ${policy.detail}`);
  out("");
  out(`Active project workspace: ${workspace ? `${workspace.path} (selected ${workspace.selectedAt})` : "none set"}`);
  out("");
  out(`Self-verify critic policy: ${selfVerify} (local-provider stages are always critiqued regardless of this setting)`);
  out("");
  out("Feature flags:");
  for (const flag of FEATURE_FLAGS) {
    const enabled = flagValues[flag.key];
    out(`  ${(enabled ? "ON " : "off").padEnd(4)} ${flag.label.padEnd(30)} (store key: ${flag.key}, default ${flag.default})`);
  }
  out("");
  out(`App data directory: ${deps.userDataPath}`);
  return 0;
}

// --- chat / build ------------------------------------------------------

function assessOutcome(run: SessionRun): { ok: boolean; reason?: string } {
  if (run.providerResult?.source === "placeholder") {
    return { ok: false, reason: run.providerResult.output };
  }
  if (run.stages && run.stages.length > 0 && run.stages.every((stage) => stage.failed)) {
    return { ok: false, reason: "Every build stage failed - see the stage fallback notes above." };
  }
  if (run.pipelineName === "Build Orchestration Pipeline" && !run.projectResult) {
    return { ok: false, reason: "The build pipeline ran but no complete project files were extracted or written." };
  }
  if (run.projectResult && !run.projectResult.verified) {
    return { ok: false, reason: `Build verification failed: ${run.projectResult.verificationDetail}` };
  }
  return { ok: true };
}

function printSummary(run: SessionRun, totalMs: number, sawMessageDelta: boolean): void {
  out("");
  out("----------------------------------------");
  const selectedRoute = run.decision.decision.selected_route;
  const routeLine = run.providerResult
    ? `${run.providerResult.provider}/${run.providerResult.model} (answered via source: ${run.providerResult.source})`
    : selectedRoute.provider && selectedRoute.model
      ? `${selectedRoute.provider}/${selectedRoute.model} (routing decision only - see stages below for what actually ran)`
      : "(no single resolved provider/model - see stages below)";
  out(`Route:       ${routeLine}`);
  out(
    `Task type:   ${run.decision.decision.task_type} (confidence ${run.decision.decision.confidence}, decision source: ${run.decision.source}${
      run.decision.source === "sample" ? " - metis-policy CLI unavailable" : ""
    })`
  );
  out(`Pipeline:    ${run.pipelineName}${run.routeLabel ? ` (${run.routeLabel})` : ""}${typeof run.depth === "number" ? ` depth=${run.depth}` : ""}`);

  if (!sawMessageDelta) {
    out("");
    out(`Assistant: ${run.assistantText}`);
  }

  if (run.stages?.length) {
    out("");
    out(`Stages (${run.stages.length}):`);
    for (const stage of run.stages) {
      out(`  - ${stage.label}: ${stage.failed ? "FAILED" : "ok"} via ${stage.provider}/${stage.model}`);
    }
  }

  if (run.projectResult) {
    out("");
    out(`Project root: ${run.projectResult.projectRoot}`);
    out(`Verified:     ${run.projectResult.verified ? "yes" : "no"} - ${run.projectResult.verificationDetail}`);
    if (run.projectResult.previewUrl) out(`Preview:      ${run.projectResult.previewUrl}`);
    const written = run.projectResult.artifacts.filter((artifact) => artifact.kind === "file" || artifact.kind === "file_create");
    if (written.length) {
      out(`Files written (${written.length}):`);
      for (const artifact of written) out(`  - ${artifact.path ?? artifact.label}`);
    }
  }

  if (run.warnings.length) {
    out("");
    out("Warnings:");
    for (const warning of run.warnings) out(`  - ${warning}`);
  }

  out("");
  out(`Timing:      ttft=${typeof run.ttftMs === "number" ? `${run.ttftMs}ms` : "n/a (non-streaming call)"}  total=${totalMs}ms`);
  out("----------------------------------------");
}

async function runTurn(parsed: ParsedArgs, deps: CliRuntime): Promise<number> {
  const json = parsed.json;
  const subcommand = parsed.subcommand as "chat" | "build";

  let modelOverride: SessionModelOverride | undefined;
  if (parsed.model) {
    modelOverride = parseModelOverride(parsed.model, deps.providerInfo);
  }

  let resolvedProjectPath: string | undefined;
  if (parsed.projectPath) {
    resolvedProjectPath = resolvePath(parsed.projectPath);
    try {
      await mkdir(resolvedProjectPath, { recursive: true });
      await deps.establishWritableWorkspace(resolvedProjectPath);
    } catch (error) {
      errout(`Could not establish "${resolvedProjectPath}" as the writable project workspace: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (!json) out(`Project workspace: ${resolvedProjectPath} (writable - established for this run; permissionMode "auto")`);
  } else if (subcommand === "build" && !json) {
    out("No --project given - the build pipeline will write into Metis's own app-managed workspace folder instead of a real project.");
  }

  const promptText = subcommand === "build" ? `/orchestration ${parsed.prompt}` : (parsed.prompt as string);

  const input: SessionRunInput = {
    prompt: promptText,
    projectPath: resolvedProjectPath,
    // See the module doc comment: CLI mode always uses "auto" because there
    // is no human available to answer an in-run permission or question
    // prompt. In-run prompts are still auto-resolved (not skipped) by the
    // stream handler below, immediately, rather than left to time out.
    permissionMode: "auto",
    modelOverride
  };

  const printer = createLinePrinter(json);
  const stream = buildStream(deps, printer);

  const timeoutMs = parsed.timeoutSeconds * 1000;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Graceful first: abort every live provider fetch registered under
      // this run's scope and let the pipeline unwind through its own
      // cancellation path (same mechanism the GUI's Stop button uses). The
      // hard backstop is main.ts calling app.exit() right after this
      // function returns, which ends the process regardless of whether the
      // graceful unwind finishes in time.
      deps.requestSessionCancel(resolvedProjectPath);
      reject(new Error(`Timed out after ${parsed.timeoutSeconds}s (see --timeout).`));
    }, timeoutMs);
  });

  const startedAt = Date.now();
  let run: SessionRun;
  try {
    run = await Promise.race([deps.runSessionTracked(input, stream), timeoutPromise]);
  } catch (error) {
    printer.finish();
    const totalMs = Date.now() - startedAt;
    if (timedOut) {
      errout(`Timed out after ${parsed.timeoutSeconds}s - cancelling the in-flight run and exiting.`);
      return 124;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      out(JSON.stringify({ error: message, totalMs }, null, 2));
    } else {
      errout(`Run failed after ${totalMs}ms: ${message}`);
    }
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const totalMs = Date.now() - startedAt;
  printer.finish();

  const outcome = assessOutcome(run);

  if (json) {
    out(JSON.stringify(run, null, 2));
  } else {
    printSummary(run, totalMs, printer.sawMessageDelta);
  }
  if (!outcome.ok) {
    errout(`Exiting 3 - no real answer: ${outcome.reason ?? "unknown reason"}`);
    return 3;
  }
  return 0;
}

// --- entry point -----------------------------------------------------------

/**
 * Parses argv (the full process.argv — this function finds "--cli" itself
 * and reads everything after it), runs the requested subcommand against the
 * real pipeline via `deps`, and resolves to a process exit code. Never
 * throws — every failure path is caught and turned into a printed message
 * plus a non-zero return value, so the caller (main.ts) can always safely
 * do `app.exit(await runCliMode(...))`.
 */
export async function runCliMode(argv: string[], deps: CliRuntime): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.subcommand === "help") {
      out(usageText());
      return 0;
    }
    if (parsed.subcommand === "doctor") {
      return await runDoctor(deps, parsed.json);
    }
    return await runTurn(parsed, deps);
  } catch (error) {
    if (error instanceof CliUsageError) {
      errout(`metis --cli: ${error.message}`);
      errout("");
      errout(usageText());
      return 2;
    }
    errout(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  }
}
