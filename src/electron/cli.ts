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
import { LOOP_MAX_ITERATIONS_CEILING, type LoopRecord } from "./loops.js";

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
  /** Metis Loops phase 1 (docs/LOOPS.md). `loop` drives these two directly,
   *  in the foreground: main.ts's 60s background chain is never started in
   *  --cli mode, so a 3-iteration loop takes three model calls rather than
   *  three minutes. */
  createLoop(input: {
    goal: string;
    projectPath?: string;
    maxIterations?: number;
    permissionMode?: string;
    origin?: LoopRecord["origin"];
  }): Promise<LoopRecord>;
  fireLoopTick(id: string): Promise<LoopRecord | undefined>;
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
/** Loops spend this across EVERY iteration, not per iteration. */
const DEFAULT_LOOP_TIMEOUT_SECONDS = 1800;

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
  subcommand: "chat" | "build" | "doctor" | "loop" | "help";
  prompt?: string;
  projectPath?: string;
  model?: string;
  json: boolean;
  timeoutSeconds: number;
  maxIterations?: number;
  respectDelays: boolean;
}

function usageText(): string {
  return [
    "Metis Orchestrator - headless CLI mode",
    "",
    "Usage:",
    '  npm run cli -- doctor [--json]',
    '  npm run cli -- chat "<prompt>" [--project <path>] [--model <provider/model>] [--json] [--timeout <seconds>]',
    '  npm run cli -- build "<prompt>" --project <path> [--model <provider/model>] [--json] [--timeout <seconds>]',
    '  npm run cli -- loop "<goal>" [--max-iterations <n>] [--project <path>] [--respect-delays] [--json]',
    "",
    "Flags:",
    "  --project <path>          Establishes <path> as the writable project workspace for this run",
    "                             (same grant selectProjectWorkspace's \"Choose folder\" writes). Created",
    "                             on disk first if it doesn't exist yet. Without it, build writes into",
    "                             Metis's own app-managed workspace folder instead of a real project.",
    "  --model <provider/model>  Pins a model instead of Auto Router, e.g. ollama/qwen3:8b or",
    "                             anthropic/claude-sonnet-5. Maps onto SessionRunInput.modelOverride.",
    "                             chat/build only.",
    "  --max-iterations <n>      loop only. Hard cap on how many times the loop may wake. Default 8,",
    `                             clamped to at most ${LOOP_MAX_ITERATIONS_CEILING} (src/electron/loops.ts). The loop can still stop`,
    "                             itself earlier, and usually should.",
    "  --respect-delays          loop only. Actually sleep the delay the model asked for between",
    "                             iterations. Off by default: a loop that asks for 900s three times",
    "                             would otherwise take 45 minutes to exercise three ticks.",
    "  --json                    Print one machine-readable JSON blob instead of the human stream —",
    "                             the SessionRun object for chat/build, the final LoopRecord for loop,",
    "                             the report object for doctor — and nothing else to stdout, for",
    "                             assertions in tests.",
    "  --timeout <seconds>       Overall wall-clock budget before the run is cancelled and the process",
    `                             exits non-zero. Default ${DEFAULT_TIMEOUT_SECONDS}, and ${DEFAULT_LOOP_TIMEOUT_SECONDS} for loop, which spends`,
    "                             it across every iteration together rather than each one.",
    "",
    'Permissions: every run uses permissionMode "auto" — there is no human in CLI mode to answer a',
    "permission prompt or an <ask_user> question, so both are auto-resolved the instant they fire",
    "(permission prompts: allowed for this run only, nothing new is persisted beyond the workspace",
    "grant --project itself creates; questions: answered with their first offered option) and printed",
    "as they happen instead of silently blocking for 5 minutes and then defaulting.",
    "",
    "A loop is an autonomous run: each iteration decides for itself whether there is another one, and",
    "silence stops it. Loops created here are recorded with origin \"cli\" and are NEVER resumed by the",
    "desktop app on a later launch - a Ctrl-C partway through leaves a stopped record, not a background",
    "run the app picks up hours later with nowhere to show it.",
    "",
    "Exit codes:",
    "  0    success - a real provider answered (chat) or the build wrote and verified cleanly (build),",
    "       or doctor ran, or the loop ended on its own terms (stopped or exhausted).",
    "  1    the run threw (unexpected internal error).",
    "  2    CLI usage error (bad flags/arguments) - nothing was run.",
    "  3    the run completed but did not get a real answer - e.g. Ollama unreachable and no cloud key",
    "       configured, every build stage failed, build verification failed, or a loop iteration errored",
    "       (status \"failed\"). See stderr / warnings for the honest reason.",
    "  124  timed out (see --timeout)."
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const cliIndex = argv.indexOf("--cli");
  const rest = cliIndex >= 0 ? argv.slice(cliIndex + 1) : argv.slice();

  let json = false;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let timeoutExplicit = false;
  let projectPath: string | undefined;
  let model: string | undefined;
  let maxIterations: number | undefined;
  let respectDelays = false;
  let helpRequested = false;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--respect-delays") {
      respectDelays = true;
      continue;
    }
    if (token === "--max-iterations") {
      const value = rest[++i];
      const parsedIterations = value ? Number(value) : NaN;
      if (!Number.isInteger(parsedIterations) || parsedIterations <= 0) {
        throw new CliUsageError(`--max-iterations requires a positive whole number, got "${value ?? ""}".`);
      }
      maxIterations = parsedIterations;
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
      timeoutExplicit = true;
      continue;
    }
    if (token.startsWith("--")) {
      throw new CliUsageError(`Unknown flag: ${token}`);
    }
    positionals.push(token);
  }

  if (helpRequested) {
    return { subcommand: "help", json, timeoutSeconds, respectDelays };
  }

  const subcommand = positionals.shift();
  if (!subcommand) throw new CliUsageError("Missing subcommand. Expected one of: chat, build, doctor, loop.");
  if (subcommand !== "chat" && subcommand !== "build" && subcommand !== "doctor" && subcommand !== "loop") {
    throw new CliUsageError(`Unknown subcommand "${subcommand}". Expected one of: chat, build, doctor, loop.`);
  }

  let prompt: string | undefined;
  if (subcommand === "chat" || subcommand === "build" || subcommand === "loop") {
    prompt = positionals.shift();
    const label = subcommand === "loop" ? "goal" : "prompt";
    if (!prompt || !prompt.trim()) {
      throw new CliUsageError(`"${subcommand}" requires a ${label} argument, e.g. npm run cli -- ${subcommand} "hello"`);
    }
  }

  if (positionals.length > 0) {
    throw new CliUsageError(`Unexpected extra argument(s): ${positionals.join(" ")}`);
  }

  // Rejected rather than ignored: a flag that silently does nothing is worse
  // than one that fails, because the user believes it took effect. --model in
  // particular would look like it pinned the loop's model when loop ticks go
  // through the Auto Router regardless.
  if (subcommand === "loop" && model) {
    throw new CliUsageError('"loop" does not support --model: every loop iteration routes through the Auto Router.');
  }
  if (subcommand !== "loop" && (maxIterations !== undefined || respectDelays)) {
    throw new CliUsageError(`--max-iterations and --respect-delays only apply to "loop", not "${subcommand}".`);
  }

  // A loop's budget covers EVERY iteration together, so the single-run default
  // is the wrong scale for it: a legitimate 3-iteration loop on the Auto Router
  // measured ~450s and was killed at 300s mid-flight, reporting a timeout for a
  // loop that was working correctly. Only raised when the caller did not ask
  // for a specific budget, so an explicit --timeout still wins.
  if (subcommand === "loop" && !timeoutExplicit) {
    timeoutSeconds = DEFAULT_LOOP_TIMEOUT_SECONDS;
  }
  return { subcommand, prompt, projectPath, model, json, timeoutSeconds, maxIterations, respectDelays };
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

// --- chat / build / loop ---------------------------------------------------

/** Establishes --project as this run's writable workspace, the same grant the
 *  GUI's "Choose folder" writes. Resolves to the absolute path, `undefined`
 *  when no --project was given, or `null` when the grant could not be
 *  established — the caller exits 1 on null rather than continuing, because
 *  running on without the grant only defers the failure to the first write,
 *  deep inside a pipeline, where the reason is much harder to read. */
async function establishCliWorkspace(parsed: ParsedArgs, deps: CliRuntime): Promise<string | undefined | null> {
  if (!parsed.projectPath) return undefined;
  const resolved = resolvePath(parsed.projectPath);
  try {
    await mkdir(resolved, { recursive: true });
    await deps.establishWritableWorkspace(resolved);
  } catch (error) {
    errout(`Could not establish "${resolved}" as the writable project workspace: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!parsed.json) out(`Project workspace: ${resolved} (writable - established for this run; permissionMode "auto")`);
  return resolved;
}

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

  const resolvedProjectPath = await establishCliWorkspace(parsed, deps);
  if (resolvedProjectPath === null) return 1;
  if (!resolvedProjectPath && subcommand === "build" && !json) {
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

// --- loop ------------------------------------------------------------------

/** Seconds until the loop's next wake, which is also the delay the model asked
 *  for. LoopIterationRecord deliberately does not carry the number (loops.ts
 *  is a fixed interface) and nextWakeAt is the only place the clamped value
 *  survives. Undefined when the loop was not re-armed. */
function secondsUntilWake(loop: LoopRecord): number | undefined {
  if (!loop.nextWakeAt) return undefined;
  const ms = new Date(loop.nextWakeAt).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : undefined;
}

/** One line per iteration: what the model decided, and why it said it decided
 *  that. Reads the last history entry rather than a return value so the line
 *  is built from what was actually persisted. */
function describeLoopIteration(loop: LoopRecord): string {
  const entry = loop.history[loop.history.length - 1];
  if (!entry) return `iteration ${loop.iterations}: (no history entry was written)`;
  const head = `iteration ${entry.index}`;
  if (entry.error) return `${head}: failed - ${truncate(entry.error, 200)}`;
  if (entry.decision === "silent") return `${head}: no decision block - stopping, because continuing has to be asked for`;
  if (entry.decision === "stop") return `${head}: stop - ${entry.reason ?? "no reason given"}`;
  const seconds = secondsUntilWake(loop);
  const delay = seconds === undefined ? "not re-armed" : `${seconds}s requested`;
  return `${head}: continue (${delay}) - ${entry.reason ?? loop.lastReason ?? "no reason given"}`;
}

/** Drives a loop to its terminal state in the foreground. main.ts's 60s chain
 *  is never started in --cli mode (see the cliMode branch of app.whenReady),
 *  so every tick here is fired directly and back to back — the point of the
 *  harness is that `--max-iterations 3` finishes in three model calls, not
 *  three minutes. --respect-delays opts back into real waits. */
async function runLoop(parsed: ParsedArgs, deps: CliRuntime): Promise<number> {
  const json = parsed.json;

  const resolvedProjectPath = await establishCliWorkspace(parsed, deps);
  if (resolvedProjectPath === null) return 1;

  let loop: LoopRecord;
  try {
    loop = await deps.createLoop({
      goal: parsed.prompt as string,
      projectPath: resolvedProjectPath,
      maxIterations: parsed.maxIterations,
      // Pinned for the same reason chat/build pin it (see the module doc
      // comment): the loop freezes this mode onto its record at creation, and
      // there is no human here to answer what "ask" would raise every wakeup.
      permissionMode: "auto",
      // Marks the record as belonging to this process. The app closes cli
      // loops out on its next launch instead of resuming them, because once
      // this process exits nothing is left that can show one or stop it.
      origin: "cli"
    });
  } catch (error) {
    errout(`Could not create the loop: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (!json) {
    out(`Loop ${loop.id}`);
    out(`Goal:        ${loop.goal}`);
    out(`Iterations:  up to ${loop.maxIterations}`);
    out(`Permissions: ${loop.permissionMode} (no human in CLI mode - an ungranted action is denied outright, not queued)`);
    out(`Delays:      ${parsed.respectDelays ? "honoured as the model asks for them" : "skipped - pass --respect-delays for a realistic run"}`);
    out("");
  }

  const timeoutMs = parsed.timeoutSeconds * 1000;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Same graceful-then-hard shape as runTurn: abort the live provider
      // calls for this scope, then let main.ts's app.exit end the process.
      deps.requestSessionCancel(resolvedProjectPath);
      reject(new Error(`Timed out after ${parsed.timeoutSeconds}s (see --timeout).`));
    }, timeoutMs);
  });

  const drive = async (): Promise<LoopRecord> => {
    let current = loop;
    // Bounded by the same ceiling the record itself is clamped to, plus the
    // one extra pass that turns a capped loop terminal. A harness whose whole
    // purpose is a bounded run must not be able to spin here even if a future
    // fireLoopTick ever stops advancing the record.
    for (let guard = 0; guard <= LOOP_MAX_ITERATIONS_CEILING; guard++) {
      const ticked = await deps.fireLoopTick(current.id);
      if (!ticked) throw new Error(`Loop ${current.id} vanished from the store mid-run.`);
      current = ticked;
      if (!json) out(describeLoopIteration(current));
      if (current.status !== "sleeping") return current;
      if (parsed.respectDelays) {
        const seconds = secondsUntilWake(current) ?? 0;
        if (seconds > 0) {
          if (!json) out(`             sleeping ${seconds}s before the next iteration (--respect-delays)`);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, seconds * 1000));
        }
      }
    }
    return current;
  };

  const startedAt = Date.now();
  let finalLoop: LoopRecord;
  try {
    finalLoop = await Promise.race([drive(), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      errout(`Timed out after ${parsed.timeoutSeconds}s - cancelling the in-flight iteration and exiting.`);
      errout(`Loop ${loop.id} is left as it stands; the app closes cli loops out on its next launch rather than resuming them.`);
      return 124;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      out(JSON.stringify({ error: message, loopId: loop.id }, null, 2));
    } else {
      errout(`Loop failed after ${Date.now() - startedAt}ms: ${message}`);
    }
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const totalMs = Date.now() - startedAt;
  if (json) {
    out(JSON.stringify(finalLoop, null, 2));
  } else {
    out("");
    out("----------------------------------------");
    out(`Status:       ${finalLoop.status}`);
    out(`Iterations:   ${finalLoop.iterations} of ${finalLoop.maxIterations}`);
    out(`Reason:       ${finalLoop.stoppedReason ?? "(none recorded)"}`);
    out(`Conversation: ${finalLoop.conversationId ?? "(none - no iteration produced a run)"}`);
    out(`Timing:       total=${totalMs}ms`);
    out("----------------------------------------");
  }

  if (finalLoop.status === "failed") {
    errout(`Exiting 3 - the loop failed: ${finalLoop.stoppedReason ?? "unknown reason"}`);
    return 3;
  }
  // "stopped" and "exhausted" are both clean endings: a loop that stops itself
  // early is the behaviour this feature wants, not a failure.
  if (finalLoop.status !== "stopped" && finalLoop.status !== "exhausted") {
    errout(`Exiting 3 - the loop is still "${finalLoop.status}" after ${finalLoop.iterations} iteration(s) and never reached a terminal state.`);
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
    if (parsed.subcommand === "loop") {
      return await runLoop(parsed, deps);
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
