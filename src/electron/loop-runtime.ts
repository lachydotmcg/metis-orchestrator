/** The Metis Loops RUNTIME, lifted out of main.ts.
 *
 *  Second carve of docs/STRUCTURAL_DEBT.md item 1, after the gateway. 1,382
 *  lines, and it needs thirteen things from main.ts — the same ratio the gateway
 *  came out at, over two and a half times the size.
 *
 *  **Why not `./loops.ts`, which already exists.** That file is deliberately
 *  electron-free: it holds the types and the pure decision helpers, and
 *  `cli.ts` and `gateway.ts` both import it precisely because importing it
 *  costs them nothing. This half needs `BrowserWindow` to broadcast
 *  `metis-loops:changed`, so merging the two would drag electron into every
 *  consumer of `LoopRecord`. The split is not accidental and this file keeps it:
 *  `loops.ts` is what a loop IS, this is what running one DOES.
 *
 *  Dependencies are injected for the same reason the gateway's are — importing
 *  them would make `main -> loop-runtime -> main`. See `configureLoopRuntime`.
 */

import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  LOOP_COMMAND_DEFAULT_GATE_ATTEMPTS,
  LOOP_COMMAND_MAX_GATE_ATTEMPTS,
  LOOP_COMMAND_MAX_GROUP,
  LOOP_COMMAND_MAX_INTERVAL_SECONDS,
  LOOP_COMMAND_MAX_STEPS,
  LOOP_COMMAND_MIN_BUDGET_TOKENS,
  cleanDraftedChain,
  countChainSteps,
  fanoutMemberPosition,
  formatStepChain,
  parseStepChain,
  stepVariableName,
  type LoopGate,
  type LoopStepPosition
} from "../shared/loop-command.js";
import { clampPermissionMode } from "../shared/intent-and-paths.js";
import { routePricing } from "../shared/model-catalogue.js";
import { formatWalkthrough, walkthroughFileName, type WalkthroughFile, type WalkthroughRouting } from "../shared/walkthrough.js";
import type {
  AuditEvent,
  CatalogModel,
  PermissionMode,
  ProviderInvokeResult,
  SecretStatus,
  SessionStreamEvent
} from "../shared/runtime-contracts.js";
import {
  assessLoopCapability,
  captureArtifact,
  composeWakePrompt,
  currentLoopStep,
  decideLoopContinuation,
  extractGateVerdict,
  extractLoopDecision,
  gateAppliesToTurn,
  gatePromptFor,
  inlineDecisionNeedsSecondOpinion,
  latestArtifact,
  loopTerminalReason,
  loopTurnLabel,
  nextStepIndex,
  parallelInstanceBrief,
  summariseTurn
} from "./loops.js";

/** Structural twin of main.ts's private `SessionStreamController`, the same
 *  trick `cli.ts` and `gateway.ts` both use: main never exports the type and
 *  does not need to, because TypeScript matches by shape. */
type SessionStreamController = {
  emit: (event: SessionStreamEvent) => void;
  /** True when nothing human is on the other end — a loop tick, not a window.
   *  Kept on the twin because a loop tick is the ONLY caller that sets it: drop
   *  it and an unanswerable ask silently defaults instead of settling the loop
   *  as blocked. */
  unattended?: boolean;
};

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOOP_ARTIFACT_LIMIT,
  LOOP_EVIDENCE_MAX,
  LOOP_MAX_AGE_HOURS,
  LOOP_MAX_DELAY_SECONDS,
  LOOP_MAX_ITERATIONS_CEILING,
  LOOP_MAX_SPAWNED_TOTAL,
  LOOP_MAX_SPAWN_PER_TURN,
  LOOP_MIN_DELAY_SECONDS,
  evidenceFromOperations,
  filesFromOperations,
  trimToTail,
  type CurrentLoopStep,
  type LoopEvidence,
  type LoopIterationRecord,
  type LoopRecord,
  type LoopSpawnRequest,
  type LoopSpawnedAgent,
  type LoopStatus
} from "./loops.js";

/** Everything the loop runtime needs that still lives in main.ts.
 *
 *  Thirteen, measured rather than guessed. Three of them
 *  (`loopCancelScope`, `loopJudgeInvoker`, `loopSpentTokens`) are loop
 *  functions that happen to sit elsewhere in main.ts next to the code they were
 *  written beside; they are injected rather than dragged along, because moving
 *  them would pull the usage ledger and the critic loop with them and this carve
 *  is meant to be reviewable. */
export interface LoopRuntimeDeps {
  appendAudit: (level: AuditEvent["level"], kind: string, summary: string, metadata?: Record<string, unknown>) => Promise<AuditEvent>;
  readStoreValue: <T>(key: string, fallback: T) => Promise<T>;
  writeStoreValue: <T>(key: string, value: T) => Promise<void>;
  /** Injected even though ./ollama.ts is importable — it crosses a network
   *  boundary, and 32-loop-lifecycle needs to answer for it rather than call a
   *  real server during createLoop. */
  listOllamaModels: () => Promise<{ reachable: boolean; installed: string[] }>;
  listSecrets: () => Promise<SecretStatus[]>;
  isRoutinesPaused: () => Promise<boolean>;
  isCancellationError: (error: unknown) => boolean;
  requestSessionCancelScope: (scope: string) => void;
  refreshTrayMenu: () => Promise<void> | void;
  runSessionTracked: (input: any, stream?: any) => Promise<any>;
  followupInvokerFor: (result?: any) => any;
  loopCancelScope: (loopId: string) => string;
  loopJudgeInvoker: (providerResult?: any) => any;
  loopSpentTokens: (loopId: string) => Promise<number>;
  dataPath: (...parts: string[]) => string;
  /** Send a payload-free nudge to every renderer. Injected rather than done here
   *  with `BrowserWindow`, and the reason is not style: a NAMED import from
   *  "electron" throws at load time in plain node, so importing it made this
   *  whole 1,500-line module impossible to load outside the app — and therefore
   *  impossible to test. One injected function buys back the entire file. */
  notifyRenderers: (channel: string) => void;
}

let injected: LoopRuntimeDeps | null = null;

/** Wire the loop runtime. Called once from main.ts, before the scheduler can
 *  start. Module-level rather than a closure for the same reason the gateway's
 *  is: wrapping 1,382 lines in a factory means reindenting all of them, and a
 *  whitespace diff that size is one nobody reviews. */
export function configureLoopRuntime(deps: LoopRuntimeDeps): void {
  injected = deps;
}

function need(): LoopRuntimeDeps {
  if (!injected) throw new Error("The loop runtime was used before configureLoopRuntime() ran.");
  return injected;
}

// ---------------------------------------------------------------------------
// Metis Loops, phase 1 (docs/LOOPS.md) — a loop is a goal Metis works on
// across several turns, deciding at the end of each turn whether to wake
// again. The decision half lives in ./loops.ts, where silence parses as stop;
// everything below is the plumbing around it.
//
// The scheduler is a deliberate copy of the routine chain above rather than a
// new design: that chain already re-evaluates in 60s slices so a laptop that
// slept through a wake time self-corrects within a minute instead of
// oversleeping by however long the machine was off. An autonomous run that
// happens while nobody is watching is the last place in this app where a
// clever new timer should be invented.
let loopTimer: ReturnType<typeof setTimeout> | undefined;
let loopTickRunning = false;
// The background chain only exists once startLoopScheduler has deliberately
// started it. Without this flag, --cli mode (which returns from whenReady long
// before the scheduler is started) would still arm a timer the moment it
// created its own loop, and 60s later that timer would fire the USER'S sleeping
// app loops inside a headless CLI process with no window to show them.
let loopSchedulerStarted = false;

/** Default iteration cap when a caller does not name one. Deliberately far
 *  under LOOP_MAX_ITERATIONS_CEILING: the cost of this being too low is a loop
 *  that stops early and gets restarted, which is the cheap direction to be
 *  wrong in. */
const LOOP_DEFAULT_MAX_ITERATIONS = 8;

export async function readLoops(): Promise<LoopRecord[]> {
  return need().readStoreValue<LoopRecord[]>("loops", []);
}

async function writeLoops(next: LoopRecord[]): Promise<void> {
  await need().writeStoreValue("loops", next);
}

/** Serialises every mutation of the loops store.
 *
 *  The store is one JSON key holding the whole array, and loops gained more
 *  writers than that design ever had: the tick's start-of-turn and end-of-turn
 *  writes, the 60s scheduler chain, createLoop, createLoop's immediate
 *  fire-and-forget first tick, and stop/delete arriving over IPC from the
 *  panel. Any two of those overlapping meant a read-modify-write on a stale
 *  snapshot, and the observable result was the worst kind: a Stop the user
 *  clicked during a turn could be silently overwritten by that turn's own final
 *  write, and the loop would re-arm as if nothing had happened.
 *
 *  Every mutation now re-reads INSIDE the lock and returns the array it wants
 *  persisted, so no caller can write from a snapshot it fetched earlier. Reads
 *  are deliberately NOT queued: a stale read only ever renders a slightly old
 *  panel, and blocking them behind in-flight turns would make the UI wait on a
 *  model call.
 *
 *  Process-local. Two Metis processes sharing a store would still race, which
 *  is why cli loops are given their own origin and never resumed by the app. */
let loopMutationQueue: Promise<unknown> = Promise.resolve();

/** Loop ids with a turn in flight RIGHT NOW. createLoop fires its first turn
 *  without awaiting it, so that turn can still be running when the 60s chain
 *  next sweeps, and the record is left at status "running" with a nextWakeAt
 *  the sweep would honour. Two concurrent turns for one loop means two model
 *  calls billed into the same conversation and two writes fighting over the
 *  same record. */
const loopsTicking = new Set<string>();

/** Tells every open window that the loop store changed.
 *
 *  The app's first main-to-renderer PUSH. Every other channel here is
 *  `event.sender.send` — a reply inside an `invoke`, addressed to whoever asked
 *  — which works for streaming a run the user started and not at all for work
 *  that starts from a timer. A loop tick has no `invoke` to reply inside, so
 *  until this existed the only way a window could learn a loop had taken a turn
 *  was to keep asking, and the conversation feed did exactly that on a
 *  20-second timer.
 *
 *  Deliberately carries NO PAYLOAD. Loop records hold their whole history
 *  including per-step artifacts, so serialising the list on every write would
 *  push tens of kilobytes through IPC to say "something moved". This is an
 *  invalidation signal: the renderer re-reads if it cares, through the same
 *  `list()` it would have called anyway.
 *
 *  Every window, not just `mainWindow`: a second window would otherwise sit on
 *  stale state with no way to notice. Windows whose preload does not subscribe
 *  (Quick Ask) simply ignore it. */
export function broadcastLoopsChanged(): void {
  need().notifyRenderers("metis-loops:changed");
}

export function mutateLoops<T>(mutator: (current: LoopRecord[]) => { next: LoopRecord[]; result: T }): Promise<T> {
  const run = loopMutationQueue.then(async () => {
    const current = await readLoops();
    const { next, result } = mutator(current);
    await writeLoops(next);
    // Every loop state change flows through here, so this is the one hook the
    // tray needs to never show a stale loop list (roadmap: with headless start
    // the tray is the only surface a running loop has). Fire-and-forget, same
    // as every other refreshTrayMenu call site — a menu rebuild must never
    // slow down or fail a loop write.
    void need().refreshTrayMenu();
    // And the one hook the RENDERER needs, for exactly the same reason the tray
    // needs it: a loop tick fires from a timer, so there is no `invoke` for it
    // to reply inside, and until this existed the only way a window could learn
    // about background work was to keep asking.
    broadcastLoopsChanged();
    return result;
  });
  // The chain must survive a failed mutation, or one throw wedges every later
  // loop write for the life of the process.
  loopMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Short one-line label for audit summaries. A goal is free text and can be a
 *  paragraph; the audit log is read as a list of one-liners. */
export function loopLabel(loop: LoopRecord): string {
  const oneLine = loop.goal.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}...` : oneLine;
}

/** True only for the five real permission modes. A loop stores its mode as a
 *  plain string and hands it straight to a session run, and gatePermission's
 *  if/else chain treats anything it does not recognise as "auto" — so an
 *  unvalidated value would silently run LOOSER than a caller who asked for
 *  "plan". Unknown values are rejected at creation instead. */
function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "edits" || value === "plan" || value === "auto" || value === "bypass";
}

/** Permission modes are NOT totally ordered, which a single "looseness" list
 *  got wrong. "edits" lets file writes through with no prompt at all while
 *  still asking for commands; "auto" asks once per new scope for BOTH. So
 *  "edits" is looser than "auto" for writes and tighter for commands, and
 *  neither is simply above the other. A linear ranking that put "edits" below
 *  "auto" would have let a caller asking for "edits" past an "auto" ceiling and
 *  silently gained it unprompted write access.
 *
 *  Ranked on the two axes that actually matter instead. A requested mode is
 *  only honoured when it is no looser on EITHER axis. */

/** Read-modify-write of a single loop. Always re-reads first: a tick can take
 *  minutes, and the user stopping a different loop from the UI meanwhile must
 *  not be clobbered by a stale in-memory list. Silently does nothing when the
 *  record has since been deleted, rather than resurrecting it. */
async function persistLoop(loop: LoopRecord): Promise<void> {
  await mutateLoops((current) => ({
    // Still a no-op when the record has since been deleted, rather than
    // resurrecting it.
    next: current.some((item) => item.id === loop.id) ? current.map((item) => (item.id === loop.id ? loop : item)) : current,
    result: undefined
  }));
}

export async function listLoops(): Promise<LoopRecord[]> {
  return readLoops();
}

/** Creates a loop and arms it for an immediate first tick. Two fields are
 *  frozen onto the record here and never re-read: `permissionMode`, so a loop
 *  cannot gain permissions it did not start with by the user changing the
 *  global setting while it sleeps, and `origin`, which decides who is allowed
 *  to resume it after a restart (see LoopRecord.origin). */
export async function createLoop(input: {
  goal: string;
  projectPath?: string;
  maxIterations?: number;
  permissionMode?: string;
  origin?: LoopRecord["origin"];
  fixedIntervalSeconds?: number;
  budgetTokens?: number;
  steps?: LoopStepPosition[];
  /** The conditional edge (docs/FLOWCHART_LOOPS_V2.md piece 1). Re-validated
   *  here because this is reachable over IPC: both positions must be real
   *  indices into the chain that actually got stored, or the tick would jump
   *  the program counter somewhere that does not exist. */
  gate?: LoopGate;
  /** The conversation the loop was started FROM, so its turns land where the
   *  person was standing when they started it (docs/ROADMAP.md). Absent when a
   *  loop is started from a brand-new session that has no conversation yet, or
   *  by the CLI — see the id minted below for why that is not a fallback to
   *  invisibility. */
  conversationId?: string;
}): Promise<LoopRecord> {
  // Flowchart steps (docs/FLOWCHART_LOOPS_DESIGN.md), re-validated here
  // because this is reachable over IPC: each position is a trimmed string or
  // a capped group of them, empty positions drop, the flattened chain stays
  // under the replay-cost cap, and fewer than two positions is no chain.
  const normalisePosition = (position: unknown): LoopStepPosition | null => {
    if (typeof position === "string") {
      const text = position.replace(/\s+/g, " ").trim();
      return text || null;
    }
    if (Array.isArray(position)) {
      const members = position
        .filter((step): step is string => typeof step === "string")
        .map((step) => step.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, LOOP_COMMAND_MAX_GROUP);
      if (!members.length) return null;
      return members.length === 1 ? members[0] : members;
    }
    return null;
  };
  let validSteps: LoopStepPosition[] | undefined = Array.isArray(input.steps)
    ? input.steps.map(normalisePosition).filter((position): position is LoopStepPosition => position !== null)
    : undefined;
  if (validSteps) {
    while (validSteps.length > 0 && countChainSteps(validSteps) > LOOP_COMMAND_MAX_STEPS) validSteps = validSteps.slice(0, -1);
    if (validSteps.length < 2) validSteps = undefined;
  }
  // The gate, re-validated against the chain that actually survived the
  // normalisation above. A caller could send indices for a chain that then got
  // truncated by the step cap, and a program counter pointed past the end is
  // the one piece of loop state whose corruption is silent: it does not throw,
  // it just runs the wrong step forever. Anything that does not check out drops
  // the gate rather than the loop — a chain with no conditional edge is the
  // behaviour this feature is a superset of.
  const requestedGate = input.gate;
  const validGate: LoopGate | undefined =
    validSteps &&
    requestedGate &&
    Number.isInteger(requestedGate.at) &&
    Number.isInteger(requestedGate.target) &&
    requestedGate.at >= 0 &&
    requestedGate.at < validSteps.length &&
    requestedGate.target >= 0 &&
    requestedGate.target < validSteps.length &&
    // A group position runs as parallel helpers and never reaches a work turn,
    // so there is no single output for a verdict to be about.
    !Array.isArray(validSteps[requestedGate.at])
      ? {
          at: requestedGate.at,
          target: requestedGate.target,
          attempts: Math.min(LOOP_COMMAND_MAX_GATE_ATTEMPTS, Math.max(1, Math.floor(Number(requestedGate.attempts) || LOOP_COMMAND_DEFAULT_GATE_ATTEMPTS)))
        }
      : undefined;

  // A steps-only command has no separate goal text; the chain IS the goal,
  // and doubles as the record's label in the panel and audit log.
  const goal = (typeof input.goal === "string" ? input.goal.trim() : "") || (validSteps ? formatStepChain(validSteps) : "");
  if (!goal) throw new Error("A loop needs a goal.");

  // The ceiling is the only thing standing between a caller-supplied number
  // and an unbounded autonomous run, so it is applied to whatever actually
  // arrives here rather than trusted to have been applied upstream.
  const requested = Number.isFinite(input.maxIterations) ? Math.floor(Number(input.maxIterations)) : LOOP_DEFAULT_MAX_ITERATIONS;
  const maxIterations = Math.min(LOOP_MAX_ITERATIONS_CEILING, Math.max(1, requested));

  // The user's own setting is a CEILING, not just a fallback. A caller may ask
  // for a mode no looser than what the owner already runs interactively, and
  // anything looser is clamped down to it rather than honoured.
  //
  // This matters now that a loop can be started from the composer: without the
  // clamp, any caller that can reach this function could start an unattended
  // bypass-mode run on a machine whose owner deliberately runs in "ask". The
  // whole point of freezing the mode onto the record was that a loop must never
  // be a permission laundering route, and accepting any valid mode from the
  // caller would have reopened exactly that door from the other side.
  const ceiling = await need().readStoreValue<PermissionMode>("permissionMode", "auto");
  const requestedMode = isPermissionMode(input.permissionMode) ? input.permissionMode : ceiling;
  const permissionMode = clampPermissionMode(requestedMode, ceiling);

  // Checked at creation because that is the only moment the owner is present
  // to read it. A loop routes through the Auto Router at each tick, so this
  // reports on what is AVAILABLE rather than predicting which model answers.
  const ollama = await need().listOllamaModels().catch(() => ({ reachable: false, installed: [] as string[] }));
  const secrets = await need().listSecrets().catch(() => []);
  const capability = assessLoopCapability({
    installedLocal: ollama.installed,
    cloudConfigured: secrets.some((secret) => secret.hasSecret)
  });

  const now = new Date();
  const loop: LoopRecord = {
    id: randomUUID(),
    goal,
    projectPath: input.projectPath,
    // Known from the first moment, not discovered on the first turn.
    //
    // It used to be undefined here and filled in from whatever conversation the
    // first tick happened to create, which is precisely why a loop was
    // invisible: there was nothing to open until a turn had already finished,
    // and by then the person had moved on. Minting one when the caller has none
    // means a loop started from an empty new session still has a thread the
    // renderer can jump to immediately, and the tick's first append fills it.
    conversationId: input.conversationId || randomUUID(),
    origin: input.origin ?? "app",
    permissionMode,
    fixedIntervalSeconds: normaliseFixedInterval(input.fixedIntervalSeconds),
    budgetTokens: normaliseBudgetTokens(input.budgetTokens),
    steps: validSteps,
    stepIndex: validSteps ? 0 : undefined,
    gate: validGate,
    gateUsed: validGate ? 0 : undefined,
    capabilityWarning: capability.warning,
    status: "sleeping",
    iterations: 0,
    maxIterations,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOOP_MAX_AGE_HOURS * 3_600_000).toISOString(),
    // Due now, so a loop the user just created starts on the next slice
    // instead of appearing to do nothing for its first minute.
    nextWakeAt: now.toISOString(),
    history: []
  };

  await mutateLoops((current) => ({ next: [loop, ...current], result: undefined }));
  await need().appendAudit("info", "loop.create", `Created ${loop.origin} loop "${loopLabel(loop)}".`, {
    id: loop.id,
    maxIterations,
    permissionMode,
    origin: loop.origin,
    fixedIntervalSeconds: loop.fixedIntervalSeconds,
    budgetTokens: loop.budgetTokens,
    steps: loop.steps
  });
  scheduleNextLoopTick();
  // Start the first turn NOW rather than waiting up to a full 60s slice. A loop
  // started from the composer that sits visibly idle for a minute reads as
  // broken, and the user's most likely response is to start another one.
  // Deliberately not awaited: createLoop must return the record immediately so
  // the panel can render it as "Working now". App loops only - a cli loop is
  // driven in the foreground by its own process and firing here would double-run
  // its first turn into the same conversation.
  if (loop.origin !== "cli") {
    void fireLoopTick(loop.id).catch(async (error) => {
      await need().appendAudit("error", "loop.error", `First turn of loop "${loopLabel(loop)}" failed to start.`, {
        id: loop.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  return loop;
}

/** A user-set interval from "/loop --every". Bounded here as well as in the
 *  command parser, because the parser runs in the renderer and this function is
 *  reachable over IPC: a renderer bug or any other caller must not be able to
 *  install a 1-second interval on an unattended run. */
function normaliseFixedInterval(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const rounded = Math.round(Number(seconds));
  if (rounded <= 0) return undefined;
  return Math.min(LOOP_COMMAND_MAX_INTERVAL_SECONDS, Math.max(LOOP_MIN_DELAY_SECONDS, rounded));
}

/** A user-set token budget from "/loop --budget". Floored here as well as in
 *  the command parser, for the same reason as normaliseFixedInterval: this is
 *  reachable over IPC, and a garbage or sub-floor budget must become "no
 *  budget" or the floor — never a loop that exhausts before its first turn
 *  lands. No upper bound: it is the owner's own spend to cap. */
function normaliseBudgetTokens(tokens: number | undefined): number | undefined {
  if (tokens === undefined || !Number.isFinite(tokens)) return undefined;
  const rounded = Math.round(Number(tokens));
  if (rounded <= 0) return undefined;
  return Math.max(LOOP_COMMAND_MIN_BUDGET_TOKENS, rounded);
}

/** Stops a loop immediately and unconditionally: the record is terminal from
 *  this moment and no further wake is armed. Any turn already in flight is
 *  left to finish rather than torn apart mid-write — fireLoopTick re-reads the
 *  record before its final write and honours a stop that landed during the
 *  run. */
export async function stopLoop(id: string, reason?: string): Promise<LoopRecord | undefined> {
  const stopped = await mutateLoops<LoopRecord | undefined>((current) => {
    const loop = current.find((item) => item.id === id);
    if (!loop) return { next: current, result: undefined };
    const marked: LoopRecord = {
      ...loop,
      status: "stopped",
      stoppedReason: reason?.trim() || "stopped by the user",
      nextWakeAt: undefined
    };
    return { next: current.map((item) => (item.id === id ? marked : item)), result: marked };
  });
  if (!stopped) return undefined;
  // Actually abort the turn if one is in flight, rather than only marking the
  // record and letting a model call the user just stopped run to completion on
  // their bill. fireLoopTick re-reads before its final write, so the stop still
  // wins the record even though the abort lands as an error inside the tick.
  need().requestSessionCancelScope(need().loopCancelScope(id));
  await need().appendAudit("info", "loop.stop", `Stopped loop "${loopLabel(stopped)}".`, {
    id,
    iterations: stopped.iterations,
    reason: stopped.stoppedReason
  });
  scheduleNextLoopTick();
  return stopped;
}

export async function deleteLoop(id: string): Promise<LoopRecord[]> {
  const { next, loop } = await mutateLoops<{ next: LoopRecord[]; loop?: LoopRecord }>((current) => {
    const found = current.find((item) => item.id === id);
    const remaining = current.filter((item) => item.id !== id);
    return { next: remaining, result: { next: remaining, loop: found } };
  });
  if (loop) {
    await need().appendAudit("info", "loop.delete", `Deleted loop "${loopLabel(loop)}".`, { id, iterations: loop.iterations });
  }
  scheduleNextLoopTick();
  return next;
}

/** Fires one iteration: composes the wake prompt from the record's own
 *  history, runs it through the normal session pipeline, and lets the model's
 *  parsed decision choose whether there is another iteration. Mirrors
 *  fireRoutine's error discipline — nothing in here throws, because one bad
 *  loop must never wedge the tick chain for every other loop. */
export async function fireLoopTick(id: string): Promise<LoopRecord | undefined> {
  // Refuse rather than queue: a second turn for a loop that is already mid-turn
  // is never wanted, and the scheduler will pick it up on the next slice if it
  // is still due once the current turn finishes.
  if (loopsTicking.has(id)) return undefined;
  // Claimed BEFORE the first await. readLoops yields the event loop, so a check
  // above an await and an add below it leaves a window where both callers see an
  // empty set and both proceed: two model calls billed into one conversation.
  loopsTicking.add(id);
  try {
    const loaded = (await readLoops()).find((item) => item.id === id);
    if (!loaded) return undefined;
    return await fireLoopTickInner(id, loaded);
  } finally {
    loopsTicking.delete(id);
  }
}

async function fireLoopTickInner(id: string, loaded: LoopRecord): Promise<LoopRecord | undefined> {

  // The ledger is only read when a budget exists to check against — most loops
  // have none, and the read costs a store round-trip per tick.
  const spentBefore = loaded.budgetTokens ? await need().loopSpentTokens(loaded.id) : undefined;

  // Checked before anything is spent: the cheapest place to stop a loop that
  // has run out of iterations, wall-clock or token budget is before it costs
  // a model call.
  const terminalBefore = loopTerminalReason(loaded, new Date(), spentBefore);
  if (terminalBefore) {
    const alreadyTerminal = loaded.status === "stopped" || loaded.status === "exhausted" || loaded.status === "failed";
    const settled: LoopRecord = {
      ...loaded,
      status: alreadyTerminal ? loaded.status : "exhausted",
      stoppedReason: alreadyTerminal ? loaded.stoppedReason : `the loop ${terminalBefore}`,
      nextWakeAt: undefined
    };
    await persistLoop(settled);
    // Only audited when the status actually changed here; a scheduler catching
    // up on an already-terminal record should not write a fresh log line every
    // time it looks at it.
    if (!alreadyTerminal) {
      await need().appendAudit("info", "loop.exhausted", `Loop "${loopLabel(settled)}" ${terminalBefore}.`, {
        id: settled.id,
        iterations: settled.iterations,
        maxIterations: settled.maxIterations
      });
    }
    return settled;
  }

  // Flowchart "&" groups (docs/FLOWCHART_LOOPS_DESIGN.md): a group position
  // launches its members as phase 2A helpers instead of running a work turn,
  // then parks until every member finishes. Handled after the terminal and
  // budget checks above, so a group launch is still bounded by everything
  // that bounds a normal turn.
  const positionNow = currentLoopStep(loaded);
  if (positionNow?.kind === "group") {
    return runLoopGroupTick(id, loaded, positionNow.members, positionNow.index);
  }

  // Marked running and persisted BEFORE the call, so the UI can show a loop
  // that is genuinely working, and so a next launch can tell a mid-iteration
  // crash apart from a loop that was merely asleep (startLoopScheduler).
  const startedAt = new Date().toISOString();
  await persistLoop({ ...loaded, status: "running" });

  const index = loaded.iterations + 1;
  let assistantText = "";
  let conversationId = loaded.conversationId;
  let runError: string | undefined;
  /** True when the turn ended because someone pressed Stop, not because it
   *  broke. Kept separate so the branches below can tell them apart. */
  let runCancelled = false;
  /** Which model actually answered this turn. Captured out of the try so the
   *  decision branches below can name it, which is what makes a silent turn
   *  actionable rather than mysterious. */
  let answeringModel: string | undefined;
  /** Passed to the decision call so it uses the same model that just did the
   *  work, falling back to the local one when the work path produced none. */
  let providerResultForDecision: ProviderInvokeResult | undefined;
  let turnEvidence: LoopEvidence[] = [];
  let turnRouting: WalkthroughRouting | undefined;
  let turnFiles: WalkthroughFile[] = [];
  let turnSnapshot: { id: string; dir: string } | undefined;
  // What the turn needed a human for. A loop has no window, so an ask that
  // reaches here is one nobody can answer — the run parks rather than
  // proceeding on the default (docs/ROADMAP.md, feedback channel face 2).
  const turnAsks: string[] = [];
  const loopAskRecorder: SessionStreamController = {
    unattended: true,
    emit: (event) => {
      if (event.kind === "permission_request") turnAsks.push(`permission to ${event.request.scope} on ${event.request.target}`);
      else if (event.kind === "user_question") turnAsks.push(event.question.text);
    }
  };
  try {
    const run = await need().runSessionTracked({
      prompt: composeWakePrompt(loaded),
      // Route on the GOAL, not the wake prompt. The wake prompt has to carry
      // the metis-loop protocol block, and a fenced JSON block classifies as
      // "coding" whatever the goal actually asks for - which is how a loop
      // asked to COUNT the functions in app.js ended up rewriting it from 171
      // lines to 10. The user's intent lives in the goal; the rest is
      // scaffolding Metis wrote to itself and must not be judged on.
      // For a flowchart loop the CURRENT STEP is this turn's goal — a "read
      // the project" step must route as reading even when a later step in the
      // same chain says "implement". A group position never reaches this
      // call (runLoopGroupTick returns before the work turn), so the
      // single-kind guard is belt and braces.
      routingPrompt: positionNow?.kind === "single" ? positionNow.text : loaded.goal,
      // Its OWN cancel scope. A loop runs in whatever folder it was started from,
      // which is usually the folder the user is actively chatting in, and the
      // composer Stop cancels by project path. Without this, stopping a chat
      // turn also aborted every in-flight loop call in that folder and marked
      // the loop failed with no retry.
      cancelScope: need().loopCancelScope(loaded.id),
      // Attributes this turn's spend to the loop in the usage ledger.
      loopId: loaded.id,
      // And makes the turn READ as a loop turn in the conversation it lands in
      // rather than as something the owner typed (docs/ROADMAP.md).
      loopTurn: { index, label: loopTurnLabel(loaded, index) },
      conversationId: loaded.conversationId,
      projectPath: loaded.projectPath,
      // The mode captured at creation, never the current global — see
      // createLoop. Cast because LoopRecord stores it as a plain string;
      // createLoop is what guarantees the value is a real mode.
      permissionMode: loaded.permissionMode as PermissionMode,
      rawPromptStorage: "local-only"
    }, loopAskRecorder);
    assistantText = run.assistantText ?? "";
    conversationId = run.conversationId ?? loaded.conversationId;
    answeringModel = run.providerResult?.model;
    providerResultForDecision = run.providerResult;
    // The feedback channel. These were always on the run; the tick just never
    // looked at them (docs/ROADMAP.md, the loop feedback channel design note).
    turnEvidence = evidenceFromOperations(run.operations ?? []);
    turnFiles = filesFromOperations(run.operations ?? []);
    // Captured now, not read from lastProjectSnapshot when the loop settles:
    // that key holds one slot and every later write overwrites it.
    turnSnapshot = run.projectResult?.snapshot;
    // The routing trace, captured here rather than joined from the usage ledger
    // later: the ledger rolls off at 5000 rows and has never carried the judged
    // depth, which is the one column of the walkthrough no competitor can
    // print (docs/COMPETITIVE_SWEEP.md, shortlist item 1).
    const runDurationMs =
      run.createdAt && run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.createdAt)) : undefined;
    turnRouting = {
      ...(run.providerResult?.provider ? { provider: run.providerResult.provider } : {}),
      ...(run.providerResult?.model ? { model: run.providerResult.model } : {}),
      ...(run.depth ? { depth: run.depth } : {}),
      ...(run.depthPromotedFrom ? { promotedFrom: run.depthPromotedFrom } : {}),
      ...(typeof run.providerResult?.usage?.inputTokens === "number" ? { inputTokens: run.providerResult.usage.inputTokens } : {}),
      ...(typeof run.providerResult?.usage?.outputTokens === "number" ? { outputTokens: run.providerResult.usage.outputTokens } : {}),
      ...(run.providerResult?.usage?.estimated ? { estimated: true } : {}),
      ...(Number.isFinite(runDurationMs) && runDurationMs ? { durationMs: runDurationMs } : {})
    };
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
    runCancelled = need().isCancellationError(error);
  }

  // A failed turn produced no reply to read a decision out of, so it is never
  // parsed as one: an error is its own outcome, not a silent stop.
  // The work turn is asked for a decision block first, because a plain chat
  // turn answers inline and that costs nothing extra. When there is no block,
  // ask separately rather than giving up: a turn that routed to the build/edit
  // pipeline replies with a pipeline SUMMARY, not a model answer, so there was
  // never anywhere for a block to come from and every loop that did real work
  // stopped after exactly one turn.
  let decision = runError ? null : extractLoopDecision(assistantText);
  let decisionAsked = false;
  let judgedBy: LoopIterationRecord["judgedBy"];
  // True when the turn asked to continue and an independent model said
  // otherwise. Changes how the stop is REPORTED: a loop that was overruled did
  // not stop itself, and saying it did would hide the disagreement.
  let judgeOverrode = false;
  let gateVerdict: "pass" | "fail" | null = null;
  // Re-measured AFTER the work turn: runSessionTracked just appended this
  // turn's ledger rows, and the budget must count the spend that already
  // happened, not the total as of one turn ago.
  const spentAfter = loaded.budgetTokens ? await need().loopSpentTokens(loaded.id) : undefined;
  // Terminal check BEFORE paying for the fallback call. The record is about to
  // be settled as exhausted either way, so asking costs a model call whose
  // answer is discarded.
  const alreadyTerminal = loopTerminalReason({ ...loaded, iterations: index }, new Date(), spentAfter) !== null;
  if (!runError && !decision && !alreadyTerminal) {
    decisionAsked = true;
    const judge = need().loopJudgeInvoker(providerResultForDecision);
    decision = await decideLoopContinuation(judge.invoke, {
      goal: loaded.goal,
      whatHappened: summariseTurn(assistantText, 600),
      turnsLeft: Math.max(0, loaded.maxIterations - index),
      // The judge grades against what ran, not against the turn's own account
      // of itself. Same evidence the next wake prompt gets, one turn earlier.
      evidence: turnEvidence
    });
    judgedBy = judge.judgedBy();
  } else if (!runError && !alreadyTerminal && inlineDecisionNeedsSecondOpinion(decision)) {
    // The turn answered inline, and what it said about itself was "keep going".
    //
    // That used to stand unchallenged, on the reasoning that a turn doing real
    // work routes to the build pipeline and therefore always takes the branch
    // above. It does not: every wake prompt appends the decision block, so any
    // chat-routed turn answers inline — which is every step of a
    // `plan -> draft -> review -> synthesise` chain. The self-graded path was
    // the whole flowchart feature, not an edge case.
    //
    // Only a continue is re-checked. Stopping is the recoverable direction and
    // needs no second opinion; "I am not finished" is the answer that spends
    // money on every turn it buys.
    const judge = need().loopJudgeInvoker(providerResultForDecision);
    const verdict = await decideLoopContinuation(judge.invoke, {
      goal: loaded.goal,
      whatHappened: summariseTurn(assistantText, 600),
      turnsLeft: Math.max(0, loaded.maxIterations - index),
      evidence: turnEvidence
    });
    judgedBy = judge.judgedBy();
    // A null verdict KEEPS the model's own continue. Unlike the branch above,
    // silence here is not the absence of a decision — the turn made one — and
    // an unreachable judge is not evidence against it. Same reasoning as
    // loopJudgeInvoker's own fallback: a self-judge beats no loop.
    if (verdict && verdict.decision !== "continue") {
      await need().appendAudit("info", "loop.judge.override", `Loop "${loopLabel(loaded)}" asked to continue on iteration ${index}; an independent model disagreed.`, {
        id,
        iteration: index,
        judgedBy: judgedBy?.model,
        verdict: verdict.decision,
        reason: verdict.reason
      });
      judgeOverrode = true;
      decision = verdict;
    }
    // A confirmed continue keeps the ORIGINAL decision object, not the
    // judge's: the delay and any spawn requests were the working model's to
    // make, and the judge was asked whether to go on, not how.
  }

  // THE GATE (docs/FLOWCHART_LOOPS_V2.md piece 1). Asked only when this turn
  // was the gated step, the step produced something, the loop is continuing,
  // and the gate has attempts left — a verdict on a turn that already failed,
  // or on a chain that is about to stop, is a model call whose answer nothing
  // reads.
  //
  // The judge is loopJudgeInvoker, so it is NOT the model that did the work.
  // Self-preference bias in LLM judges is well documented, and a step grading
  // its own output is precisely the arrangement a gate exists to avoid.
  if (!runError && decision?.decision === "continue" && gateAppliesToTurn(loaded, positionNow?.kind === "single" ? positionNow.index : null)) {
    const gateJudge = need().loopJudgeInvoker(providerResultForDecision);
    try {
      const reply = await gateJudge.invoke(
        gatePromptFor({
          goal: loaded.goal,
          step: positionNow?.kind === "single" ? positionNow.text : loaded.goal,
          produced: captureArtifact(assistantText, 2000),
          evidence: turnEvidence
        })
      );
      // A placeholder is "no model was reachable", not a verdict. Reading it as
      // one would turn an outage into an infinite retry.
      gateVerdict = reply && reply.source !== "placeholder" ? extractGateVerdict(reply.output) : null;
    } catch {
      // Silence falls through: a gated chain with a broken judge degrades to
      // exactly the chain it would have been without the gate.
      gateVerdict = null;
    }
    if (gateVerdict === "fail") {
      await need().appendAudit("info", "loop.gate", `Loop "${loopLabel(loaded)}" failed its gate on iteration ${index} and is going back a step.`, {
        id,
        iteration: index,
        at: loaded.gate?.at,
        target: loaded.gate?.target,
        attempt: (loaded.gateUsed ?? 0) + 1,
        attempts: loaded.gate?.attempts
      });
    }
  }
  const entry: LoopIterationRecord = {
    index,
    at: startedAt,
    summary: summariseTurn(assistantText),
    decision: decision ? decision.decision : "silent",
    reason: decision?.reason,
    error: runError,
    // Only a chain carries work between steps; a plain goal loop keeps one
    // conversation and already has its own thread. Storing it either way would
    // put a copy of every turn in the loop record for no reader.
    artifact: positionNow ? captureArtifact(assistantText) : undefined,
    // Which step produced it, so a later step can tell the draft from the
    // critique rather than guessing at three unlabelled blobs.
    step: positionNow?.kind === "single" ? positionNow.text : undefined,
    evidence: turnEvidence.length ? turnEvidence : undefined,
    // Absent rather than empty when the turn never reached a provider, so the
    // walkthrough can say "not judged" instead of inventing a routing row for a
    // turn that did not route.
    routing: turnRouting && Object.keys(turnRouting).length ? turnRouting : undefined,
    files: turnFiles.length ? turnFiles : undefined,
    snapshot: turnSnapshot,
    // Absent when the work turn carried its own decision block — that turn
    // graded itself, and saying nothing is the honest record of that.
    judgedBy
  };

  // A step that declared "as $name" writes its output under that name
  // (docs/FLOWCHART_LOOPS_V2.md piece 1). Newest write wins: a chain is a ring,
  // so the second pass through "draft as $draft" should hand later steps the
  // NEW draft, not the one from the first cycle.
  const declaredName = positionNow?.kind === "single" ? stepVariableName(positionNow.text) : null;
  const nextVariables =
    declaredName && entry.artifact
      ? { ...(loaded.variables ?? {}), [declaredName]: entry.artifact }
      : loaded.variables;

  const finishedAt = new Date();
  const advanced: LoopRecord = {
    ...loaded,
    conversationId,
    iterations: index,
    variables: nextVariables,
    history: [...loaded.history, entry],
    // Every branch below either leaves this cleared or sets a real wake, so a
    // terminal loop can never keep a wake time the scheduler would act on.
    nextWakeAt: undefined
  };

  let settled: LoopRecord;
  if (runError && runCancelled) {
    // A cancellation is not a failure, the same distinction the chat turn makes.
    // This is reached when the user pressed Stop on the loop itself: stopLoop
    // aborts the in-flight call, which surfaces here as an error. Recording it
    // as "failed" would tell the owner their loop broke when in fact it did
    // exactly what they asked.
    settled = { ...advanced, status: "stopped", stoppedReason: "stopped by the user mid-turn" };
    await need().appendAudit("info", "loop.stop", `Loop "${loopLabel(advanced)}" was stopped during iteration ${index}.`, {
      id,
      iteration: index
    });
  } else if (runError) {
    // Deliberately no retry. A loop that re-runs a failing turn every slice is
    // exactly the unattended runaway this feature has to design out, and a
    // failure the user can see and restart is better than one that hides
    // itself by eventually succeeding.
    settled = { ...advanced, status: "failed", stoppedReason: runError };
    await need().appendAudit("error", "loop.error", `Loop "${loopLabel(advanced)}" failed on iteration ${index}.`, {
      id,
      iteration: index,
      error: runError
    });
  } else if (turnAsks.length) {
    // An ask outranks whatever the model then said. It may well have gone on
    // to answer "continue" — it does not know its permission was refused by
    // absence rather than by judgement, and a loop that keeps going after
    // being silently denied is the exact unattended failure this is for. The
    // question is put in the reason so the panel, the tray and the phone all
    // show what it needed rather than only that it stopped.
    settled = {
      ...advanced,
      status: "blocked",
      stoppedReason: `the loop needed you: ${turnAsks[0]}${turnAsks.length > 1 ? ` (and ${turnAsks.length - 1} more)` : ""}`
    };
    await need().appendAudit("warning", "loop.blocked", `Loop "${loopLabel(advanced)}" asked for something on iteration ${index} with nobody watching.`, {
      id,
      iteration: index,
      asks: turnAsks.slice(0, 3)
    });
  } else if (!decision) {
    // The governing rule from loops.ts: continuing is an explicit act, so a
    // reply with no parseable decision block ends the loop.
    //
    // Naming the model that answered is the closest thing phase 1 has to the
    // capable-model gate LOOPS.md asks for, and is arguably the more useful
    // half of it. A gate would have to guess up front whether a model can
    // follow the protocol; this reports what actually happened, on the first
    // turn where it mattered, with the model's name attached. Deliberately not
    // a hard block: Metis is local-first and the loop is the one place free
    // local inference is structurally enabling, so refusing to run on small
    // models would invert the product's own argument. Say it plainly and let
    // the owner decide.
    settled = {
      ...advanced,
      status: "stopped",
      stoppedReason: decisionAsked
        ? answeringModel
          ? `the model did not ask to continue when asked directly (${answeringModel})`
          : // No model answered the work turn at all, so nothing declined
            // anything. Reporting an outage as a decision sends the owner
            // looking at their goal when the real problem is their setup.
            "no model was reachable to decide whether to continue, so the loop stopped"
        : "the model did not ask to continue"
    };
    await need().appendAudit("info", "loop.stop", `Loop "${loopLabel(advanced)}" stopped: no continue was requested on iteration ${index}.`, {
      id,
      iteration: index,
      model: answeringModel
    });
  } else if (decision.decision === "blocked") {
    // A stop that does not claim success. Its own status because the panel,
    // the tray and the phone page all read status to decide what to show, and
    // "stopped" would tell the user this finished when it did not. This is the
    // verdict that lets a loop decline to guess (docs/ROADMAP.md, the feedback
    // channel design note): without it the only answers both assert an outcome.
    settled = {
      ...advanced,
      status: "blocked",
      stoppedReason: `the loop cannot proceed without you: ${decision.reason ?? "no reason given"}`
    };
    await need().appendAudit("warning", "loop.blocked", `Loop "${loopLabel(advanced)}" blocked on iteration ${index} and is waiting for you.`, {
      id,
      iteration: index,
      reason: decision.reason
    });
  } else if (decision.decision === "stop") {
    settled = {
      ...advanced,
      status: "stopped",
      // "chose to stop" is only true when the stop was the turn's own. An
      // overridden continue is the opposite of the loop stopping itself, and
      // reporting it that way would hide the disagreement that is the whole
      // point of asking a second model.
      stoppedReason: judgeOverrode
        ? `an independent model judged this finished: ${decision.reason ?? "no reason given"}`
        : `the model chose to stop: ${decision.reason ?? "no reason given"}`
    };
    await need().appendAudit("info", "loop.stop", `Loop "${loopLabel(advanced)}" stopped itself on iteration ${index}.`, {
      id,
      iteration: index,
      reason: decision.reason
    });
  } else {
    // Re-checked against the INCREMENTED record, not the one loaded at the
    // top: the iteration just spent may have been the last one the cap
    // allows, and honouring the model's wakeup here would arm a tick that can
    // only ever bounce straight back off the terminal check.
    const terminalAfter = loopTerminalReason(advanced, finishedAt, spentAfter);
    if (terminalAfter) {
      settled = { ...advanced, status: "exhausted", stoppedReason: `the loop ${terminalAfter}` };
      await need().appendAudit("info", "loop.exhausted", `Loop "${loopLabel(advanced)}" ${terminalAfter}.`, {
        id,
        iterations: index,
        maxIterations: advanced.maxIterations,
        budgetTokens: advanced.budgetTokens,
        spentTokens: spentAfter
      });
    } else {
      // A user-set interval ("/loop --every 15m") wins over the delay the model
      // asked for. It overrides the GAP ONLY: reaching this branch already means
      // the model explicitly chose to continue, and a reply with no decision
      // still stops the loop above regardless of any interval. A fixed interval
      // must never become a way to keep a loop alive that did not ask to live.
      // Otherwise: already clamped to [LOOP_MIN_DELAY_SECONDS,
      // LOOP_MAX_DELAY_SECONDS] by extractLoopDecision, and the fallback only
      // covers the type being optional.
      const delaySeconds = advanced.fixedIntervalSeconds ?? decision.delaySeconds ?? LOOP_MIN_DELAY_SECONDS;
      settled = {
        ...advanced,
        status: "sleeping",
        lastReason: decision.reason,
        // Flowchart loops: the program counter advances on every continue,
        // wrapping implicitly — reaching the end of the chain starts it
        // again, because it is a loop (docs/FLOWCHART_LOOPS_DESIGN.md) —
        // UNLESS the gate just failed this step, which is the one edge in the
        // grammar that goes backwards (docs/FLOWCHART_LOOPS_V2.md piece 1).
        stepIndex: nextStepIndex(advanced, gateVerdict),
        gateUsed: gateVerdict === "fail" ? (advanced.gateUsed ?? 0) + 1 : advanced.gateUsed,
        nextWakeAt: new Date(finishedAt.getTime() + delaySeconds * 1000).toISOString()
      };
      await need().appendAudit("info", "loop.tick", `Loop "${loopLabel(advanced)}" continues after iteration ${index}.`, {
        id,
        iteration: index,
        delaySeconds,
        reason: decision.reason
      });
    }
  }

  // Re-read before the final write: a turn can take minutes and the stored
  // record may have moved under us. A Stop the user clicked mid-run has to
  // win over whatever the model decided during that same run, otherwise the
  // click silently re-arms the loop it was meant to kill.
  // The whole read-decide-write happens inside the lock. It used to re-read and
  // then write from that snapshot, which left a window where a Stop or a Delete
  // landing between the two was overwritten by this turn's own final write, and
  // the loop re-armed as though the user had never clicked.
  const finalRecord = await mutateLoops<LoopRecord | undefined>((current) => {
    const stored = current.find((item) => item.id === id);
    // Deleted mid-turn: stay deleted rather than being resurrected by the turn
    // that was already in flight.
    if (!stored) return { next: current, result: undefined };
    const record: LoopRecord =
      stored.status === "stopped"
        ? // Keep the user's stop and its reason, but keep the work too: the
          // iteration really happened and its history is what stops a restart
          // from repeating it.
          { ...stored, conversationId, iterations: index, history: advanced.history, nextWakeAt: undefined }
        : settled;
    return { next: current.map((item) => (item.id === id ? record : item)), result: record };
  });

  // Phase 2 (docs/LOOPS.md): helpers launch only AFTER the final write, and
  // only when the loop genuinely continues — a Stop clicked mid-turn wins
  // here exactly as it wins the record above, and a turn that settled as
  // stopped/exhausted/failed must never leave workers running behind it.
  if (finalRecord && finalRecord.status === "sleeping" && decision?.decision === "continue" && decision.spawn?.length) {
    launchLoopWorkers(finalRecord, decision.spawn);
  }
  // The loop is over: leave the owner an account of it. Never on a "sleeping"
  // record — a walkthrough rewritten every turn is a file whose modified time
  // means nothing and whose contents are always provisional.
  if (finalRecord && finalRecord.status !== "sleeping") await writeLoopWalkthrough(finalRecord);
  return finalRecord;
}

/** Writes `walkthrough.md` into the folder the loop worked in, once, when the
 *  loop settles (docs/COMPETITIVE_SWEEP.md, shortlist item 1).
 *
 *  Three refusals worth stating, because each is the difference between a
 *  useful report and an unwelcome one:
 *
 *  - **Plan mode writes nothing.** "plan" means Metis does not touch the disk,
 *    and a report is still a file appearing in someone's repo. The account is
 *    still in the app either way.
 *  - **A project folder or nothing.** No app-data fallback: a walkthrough
 *    filed somewhere the owner will never look is worse than absent, because
 *    it reads as delivered.
 *  - **It never overwrites a file it did not write.** See walkthroughFileName.
 *
 *  Failure here is logged and swallowed. A read-only folder must not turn a
 *  loop that finished its work into a loop that reports as failed. */
async function writeLoopWalkthrough(loop: LoopRecord): Promise<void> {
  if (!loop.projectPath || loop.permissionMode === "plan") return;
  if (!loop.history.length) return;
  try {
    const root = resolve(loop.projectPath);
    // The folder can be gone by now: a loop outlives the session that made it,
    // and an unattended run is exactly when a drive gets unplugged. Recreating
    // it to hold a report would be Metis inventing a directory nobody asked
    // for.
    if (!(await stat(root).then((info) => info.isDirectory()).catch(() => false))) return;
    // Priced from the catalogue at write time. A model that has since left the
    // catalogue simply has no price, and the walkthrough says so rather than
    // guessing — same rule as the Usage tab, same function.
    const catalog = await need().readStoreValue<CatalogModel[]>("modelCatalog", []);
    const pricing: Record<string, { in: number; out: number }> = {};
    for (const turn of loop.history) {
      const provider = turn.routing?.provider;
      const model = turn.routing?.model;
      if (!provider || !model) continue;
      const found = routePricing(catalog, provider, model);
      if (found) pricing[`${provider}::${model}`] = found;
    }
    const body = formatWalkthrough({
      loopId: loop.id,
      goal: loop.goal,
      status: loop.status,
      stoppedReason: loop.stoppedReason,
      createdAt: loop.createdAt,
      finishedAt: new Date().toISOString(),
      projectPath: root,
      chain: loop.steps?.length ? formatStepChain(loop.steps) : undefined,
      budgetTokens: loop.budgetTokens,
      history: loop.history,
      helpers: loop.spawnedAgents?.map((agent) => ({ name: agent.name, status: agent.status, task: agent.task })),
      pricing
    });
    // Look at the target before overwriting it. Only the head is read: enough
    // to recognise Metis's own marker, cheap on a large file that happens to
    // share the name.
    const preferred = join(root, "walkthrough.md");
    let head: string | null = null;
    try {
      const handle = await readFile(preferred, "utf8");
      head = handle.slice(0, 400);
    } catch {
      head = null;
    }
    const target = join(root, walkthroughFileName(head, loop.id));
    await writeFile(target, body, "utf8");
    await need().appendAudit("info", "loop.walkthrough", `Wrote a walkthrough for loop "${loopLabel(loop)}".`, {
      id: loop.id,
      path: target,
      turns: loop.history.length
    });
  } catch (error) {
    await need().appendAudit("warning", "loop.walkthrough.failed", `Could not write the walkthrough for loop "${loopLabel(loop)}".`, {
      id: loop.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/** "--flowchart" (docs/FLOWCHART_LOOPS_DESIGN.md): asks a model to PROPOSE a
 *  step chain for a goal. The reply is validated by the SAME parser a typed
 *  chain goes through, and what comes back is the same string the user would
 *  have typed — the renderer inserts it into the composer for review, and
 *  nothing runs until the user presses enter on it. Local-first: the drafting
 *  call goes through followupInvokerFor's default local ref, same as
 *  follow-ups and titles, because a plan draft is not worth cloud spend. */
export async function draftLoopStepChain(goal: string): Promise<{ chain?: string; error?: string }> {
  const trimmed = typeof goal === "string" ? goal.trim() : "";
  if (!trimmed) return { error: "A chain needs a goal to be drafted for." };
  try {
    const prompt = [
      "Propose a short ordered plan for the goal below, as ONE line of steps.",
      "",
      "Rules:",
      '- 2 to 6 steps separated by " -> ".',
      '- A step may pair two parallel tasks with " & ".',
      "- Each step under 60 characters, imperative, concrete.",
      "- No parentheses, no numbering, no commentary. Reply with the single line only.",
      "",
      `GOAL: ${trimmed.slice(0, 500)}`
    ].join("\n");
    const result = await need().followupInvokerFor()(prompt);
    if (!result || result.source === "placeholder") {
      return { error: "No model was reachable to draft a chain. Ollama running, or a provider key configured?" };
    }
    const line = cleanDraftedChain(result.output);
    const parsed = parseStepChain(line);
    if (parsed.error || !parsed.steps) {
      return { error: `The model's draft did not survive validation (${parsed.error ?? "empty reply"}). Try again, or type the chain with --steps.` };
    }
    return { chain: formatStepChain(parsed.steps) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** One tick of a loop parked on (or arriving at) a parallel step group.
 *
 *  Three shapes, decided by `currentGroup`:
 *  - FRESH ARRIVAL: launch one helper per member, consume an iteration,
 *    record it in history, park on the group. Refuses (settling exhausted)
 *    when the helper lifetime cap cannot fit the whole group — a partial
 *    launch would park the loop waiting for members that never started.
 *  - WAKE, MEMBERS STILL RUNNING: keep sleeping. A pure wait check costs no
 *    model call, so it does NOT consume an iteration; helper completions are
 *    the wake signal and the 60s chain is the heartbeat.
 *  - WAKE, ALL FINISHED: clear the group, advance the program counter, and
 *    arm an immediate re-tick so the next step starts now rather than on the
 *    next slice. Failed members do not fail the loop — their status replays
 *    into the next wake prompt via the helper digest, where the model can
 *    react to it. */
async function runLoopGroupTick(id: string, loaded: LoopRecord, members: string[], positionIndex: number): Promise<LoopRecord | undefined> {
  const now = new Date();

  if (!loaded.currentGroup) {
    const room = LOOP_MAX_SPAWNED_TOTAL - (loaded.spawnedAgents?.length ?? 0);
    if (room < members.length) {
      const settled: LoopRecord = {
        ...loaded,
        status: "exhausted",
        stoppedReason: `the loop reached its ${LOOP_MAX_SPAWNED_TOTAL}-helper allowance before step group ${positionIndex + 1} could start`,
        nextWakeAt: undefined
      };
      await persistLoop(settled);
      await need().appendAudit("info", "loop.exhausted", `Loop "${loopLabel(loaded)}" ran out of helper allowance at a parallel group.`, {
        id,
        group: members,
        spawned: loaded.spawnedAgents?.length ?? 0
      });
      return settled;
    }
    const startedAt = now.toISOString();
    const index = loaded.iterations + 1;
    const entry: LoopIterationRecord = {
      index,
      at: startedAt,
      summary: `started parallel steps: ${members.join(" & ")}`,
      decision: "continue"
    };
    const settled: LoopRecord = {
      ...loaded,
      iterations: index,
      history: [...loaded.history, entry],
      currentGroup: { startedAt, names: members.map((member) => member.slice(0, 40)) },
      status: "sleeping",
      nextWakeAt: new Date(now.getTime() + LOOP_MIN_DELAY_SECONDS * 1000).toISOString()
    };
    await persistLoop(settled);
    await need().appendAudit("info", "loop.tick", `Loop "${loopLabel(loaded)}" launched parallel step group ${positionIndex + 1} (${members.join(" & ")}).`, {
      id,
      iteration: index,
      members
    });
    // The members get the previous step's output. Without it each helper's
    // whole prompt was its own step text — "review" and nothing else — so a
    // group asked to review a draft was three agents reviewing a word.
    // Passed as `context`, never folded into `task`, so routing still reads
    // the step alone (see LoopSpawnRequest.context).
    const handoff = latestArtifact(settled);
    launchLoopWorkers(
      settled,
      members.map((member) => {
        // A fan-out member ("review 2of3") is told the others exist, so three
        // helpers on identical material do not produce three identical
        // readings — the one failure the debate literature actually names.
        // Rides in `context`, never in `task`, because routing classifies from
        // the task text and this is scaffolding (see LoopSpawnRequest.context).
        const position = fanoutMemberPosition(member);
        const brief = position ? parallelInstanceBrief(position.index, position.total) : null;
        const context = [brief, handoff || null].filter(Boolean).join("\n\n");
        return { name: member.slice(0, 40), task: member, context: context || undefined };
      }),
      startedAt
    );
    return settled;
  }

  const group = loaded.currentGroup;
  const agents = (loaded.spawnedAgents ?? []).filter((agent) => agent.startedAt >= group.startedAt && group.names.includes(agent.name));
  const allDone = agents.length >= group.names.length && agents.every((agent) => agent.status !== "running");
  if (!allDone) {
    const settled: LoopRecord = { ...loaded, status: "sleeping", nextWakeAt: new Date(now.getTime() + LOOP_MIN_DELAY_SECONDS * 1000).toISOString() };
    await persistLoop(settled);
    return settled;
  }

  const settled: LoopRecord = {
    ...loaded,
    currentGroup: undefined,
    stepIndex: loaded.steps?.length ? (positionIndex + 1) % loaded.steps.length : loaded.stepIndex,
    status: "sleeping",
    nextWakeAt: now.toISOString()
  };
  await persistLoop(settled);
  await need().appendAudit("info", "loop.tick", `Loop "${loopLabel(loaded)}" finished its parallel group (${agents.map((agent) => `${agent.name} ${agent.status}`).join(", ")}); moving on.`, {
    id,
    group: group.names
  });
  // This call is still inside fireLoopTick's in-flight guard, so an immediate
  // recursive tick would bounce off it. A zero-ish timeout lands after the
  // guard releases; the 60s chain remains the fallback if this process dies
  // in between.
  setTimeout(() => {
    void fireLoopTick(id).catch(() => undefined);
  }, 250);
  return settled;
}

/** Launches a turn's helper requests, enforcing the lifetime cap. Fire and
 *  forget by design: the loop is asleep while helpers work, and each helper's
 *  completion is what wakes it (runLoopWorker below). */
function launchLoopWorkers(loop: LoopRecord, requests: LoopSpawnRequest[], groupStartedAt?: string): void {
  const already = loop.spawnedAgents?.length ?? 0;
  const room = Math.max(0, LOOP_MAX_SPAWNED_TOTAL - already);
  const toRun = requests.slice(0, room);
  if (toRun.length < requests.length) {
    void need().appendAudit("info", "loop.spawn", `Loop "${loopLabel(loop)}" asked for ${requests.length} helpers but the lifetime cap of ${LOOP_MAX_SPAWNED_TOTAL} allows ${toRun.length}.`, {
      id: loop.id,
      requested: requests.length,
      launched: toRun.length
    });
  }
  for (const request of toRun) {
    void runLoopWorker(loop.id, request, groupStartedAt).catch(async (error) => {
      await need().appendAudit("error", "loop.spawn.error", `Helper "${request.name}" of loop "${loopLabel(loop)}" failed to start.`, {
        id: loop.id,
        name: request.name,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

/** Runs one helper as a normal tracked session run, attributed to the loop.
 *
 *  Deliberate deviation from LOOPS.md's phase-2 sketch, same style as the
 *  decision-channel deviation recorded there: the doc said "wired to the
 *  fan-out engine", but the fan-out engine is a BUILD-pipeline shape. A
 *  helper task ("update the README", "check the tests") is routed
 *  chat/edit/build by the same machinery every prompt goes through, which
 *  buys permission gating, the ledger (and therefore the loop's token
 *  budget covering helper spend), cancellation, and audit for free.
 *
 *  Governance, in order of what would go wrong without it: the helper
 *  inherits the loop's FROZEN permission mode, never the current global; it
 *  carries the loop's cancel scope so Stop aborts helpers mid-flight too; it
 *  carries loopId so its spend lands in the loop's ledger attribution and
 *  counts against --budget; it gets its OWN conversation so two concurrent
 *  runs never interleave one transcript; and helpers cannot spawn helpers —
 *  nothing parses a metis-loop block out of a helper's reply. */
async function runLoopWorker(loopId: string, request: LoopSpawnRequest, groupStartedAt?: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const registered = await mutateLoops<LoopRecord | undefined>((current) => {
    const loop = current.find((item) => item.id === loopId);
    if (!loop) return { next: current, result: undefined };
    // Only a live loop runs helpers — a stop that landed between launch and
    // here wins.
    if (loop.status !== "sleeping" && loop.status !== "running") return { next: current, result: undefined };
    const entry: LoopSpawnedAgent = { name: request.name, task: request.task, startedAt, status: "running", groupStartedAt };
    const updated: LoopRecord = { ...loop, spawnedAgents: [...(loop.spawnedAgents ?? []), entry] };
    return { next: current.map((item) => (item.id === loopId ? updated : item)), result: updated };
  });
  if (!registered) return;
  await need().appendAudit("info", "loop.spawn", `Loop "${loopLabel(registered)}" started helper "${request.name}".`, {
    id: loopId,
    name: request.name,
    task: request.task.slice(0, 200)
  });

  let summary: string | undefined;
  let failed = false;
  let workerConversationId: string | undefined;
  try {
    const run = await need().runSessionTracked({
      // The task leads, and anything it needs to work ON follows underneath.
      // Same ordering rule as composeWakePrompt: whatever leads decides what
      // Metis thinks it was asked to do, so the instruction stays on top and
      // the material sits below it.
      prompt: request.context ? `${request.task}\n\n(What the previous step produced, to work from:\n${request.context}\n)` : request.task,
      // Route on the TASK ALONE, never the context. The task is one clean
      // instruction; the context can be a draft full of code, and folding it
      // in here is how "review this" starts routing as a build and a reviewer
      // rewrites the thing it was asked to read.
      routingPrompt: request.task,
      cancelScope: need().loopCancelScope(loopId),
      loopId,
      projectPath: registered.projectPath,
      permissionMode: registered.permissionMode as PermissionMode,
      rawPromptStorage: "local-only"
    });
    summary = summariseTurn(run.assistantText ?? "");
    workerConversationId = run.conversationId;
  } catch (error) {
    failed = true;
    summary = error instanceof Error ? error.message : String(error);
  }

  const completedAt = new Date().toISOString();
  await mutateLoops((current) => {
    const loop = current.find((item) => item.id === loopId);
    if (!loop) return { next: current, result: undefined };
    const agents = (loop.spawnedAgents ?? []).map((agent) =>
      agent.name === request.name && agent.startedAt === startedAt
        ? { ...agent, status: (failed ? "failed" : "done") as LoopSpawnedAgent["status"], completedAt, summary, conversationId: workerConversationId }
        : agent
    );
    return { next: current.map((item) => (item.id === loopId ? { ...loop, spawnedAgents: agents } : item)), result: undefined };
  });
  await need().appendAudit(failed ? "error" : "info", failed ? "loop.spawn.error" : "loop.spawn.done", `Helper "${request.name}" of loop "${loopLabel(registered)}" ${failed ? "failed" : "finished"}.`, {
    id: loopId,
    name: request.name,
    summary: summary?.slice(0, 200)
  });

  // The event wakeup (docs/LOOPS.md "waking on events, not just timers"): a
  // finished helper wakes the sleeping loop NOW, and the 60s chain becomes
  // the fallback heartbeat. fireLoopTick's own loopsTicking guard makes
  // several helpers finishing together collapse into one tick.
  //
  // Never for a cli loop: those are driven in the FOREGROUND by their own
  // process (see LoopRecord.origin), which is already awake and will tick on
  // its own schedule — a background wake here would race that driver for the
  // same iteration and make the CLI's pacing and final report lie.
  const latest = (await readLoops()).find((item) => item.id === loopId);
  if (latest?.status === "sleeping" && latest.origin !== "cli") {
    void fireLoopTick(loopId).catch(async (error) => {
      await need().appendAudit("error", "loop.error", `Helper-completion wake of loop "${loopLabel(latest)}" failed.`, {
        id: loopId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
}

/** The scheduler chain, same shape and same 60s slice as the routine chain
 *  above: one live timer at a time, re-evaluated at least once a minute so
 *  system sleep or a clock change self-corrects rather than oversleeping. */
function scheduleNextLoopTick(): void {
  // See loopSchedulerStarted: in --cli mode the chain is never started, and
  // arming it here would let a CLI run fire the user's app loops.
  if (!loopSchedulerStarted) return;
  // Deliberately does NOT reset a pending timer. createLoop, stopLoop and
  // deleteLoop all call this, so clearing and re-arming meant a user busy in
  // the Loops panel pushed the next slice out by a fresh 60s on every click,
  // and a loop that was already due could be postponed indefinitely by
  // activity that had nothing to do with it. The chain re-arms itself from
  // runLoopTick's finally, so it only ever needs starting, never restarting.
  if (loopTimer) return;
  loopTimer = setTimeout(() => {
    loopTimer = undefined;
    void runLoopTick();
  }, 60_000);
}

async function runLoopTick(): Promise<void> {
  if (loopTickRunning) return;
  loopTickRunning = true;
  try {
    // The tray's pause covers loops too. Deliberately checked INSIDE the tick
    // rather than by declining to re-arm the chain, matching runRoutineTick:
    // the timer keeps running so unpausing takes effect within one slice
    // instead of needing something to restart the chain. A paused loop simply
    // does not fire and keeps its nextWakeAt, so it resumes where it was.
    if (await need().isRoutinesPaused()) return;
    const loops = await readLoops();
    const now = new Date();
    const due = loops.filter(
      (loop) =>
        // cli loops are driven in the foreground by the process that made
        // them. Firing one here as well would put two model runs into the
        // same conversation at once.
        loop.origin !== "cli" && loop.status === "sleeping" && loop.nextWakeAt && new Date(loop.nextWakeAt) <= now
    );
    for (const loop of due) {
      // Re-checked per loop, not once per pass. A pass over several due loops
      // runs a real model call each, so it can take minutes, and a pause
      // clicked during it used to be ignored for every loop after the first.
      if (await need().isRoutinesPaused()) return;
      await fireLoopTick(loop.id);
    }
  } finally {
    loopTickRunning = false;
    scheduleNextLoopTick();
  }
}

/** Called once on app.whenReady, next to startRoutineScheduler. Settles every
 *  loop the last process left behind before arming the chain, so nothing is
 *  ever resumed by a surface that cannot also show it. */
export async function startLoopScheduler(): Promise<void> {
  const loops = await readLoops();

  // A loop is resumed only by a surface that can also SHOW it and stop it.
  // The app has the Loops panel; the CLI has nothing once its process exits.
  // So a cli loop still sleeping (or still marked running) is the residue of a
  // Ctrl-C, a timeout or a crash, and is closed out here. Without this, killing
  // the CLI mid-loop plants an autonomous run that fires inside the desktop app
  // hours later, which the user never created and would not think to look for.
  // Applied BEFORE the interrupted-app rule below, so a cli loop stuck in
  // "running" reads as a dead CLI session rather than an app crash.
  const orphanedCli = loops.filter((loop) => loop.origin === "cli" && (loop.status === "sleeping" || loop.status === "running"));
  // An app loop left "running" is one whose iteration was cut off when the app
  // died. It is marked failed, never resumed: Metis cannot know whether that
  // turn had already written anything, and re-running it blind could repeat a
  // half-applied change.
  const interrupted = loops.filter((loop) => loop.origin !== "cli" && loop.status === "running");

  if (orphanedCli.length || interrupted.length) {
    const orphanIds = new Set(orphanedCli.map((loop) => loop.id));
    const interruptedIds = new Set(interrupted.map((loop) => loop.id));
    await writeLoops(
      loops.map((loop) => {
        if (orphanIds.has(loop.id)) {
          return { ...loop, status: "stopped" as const, stoppedReason: "the CLI session that owned this loop ended", nextWakeAt: undefined };
        }
        if (interruptedIds.has(loop.id)) {
          return { ...loop, status: "failed" as const, stoppedReason: "the app closed during this iteration", nextWakeAt: undefined };
        }
        return loop;
      })
    );
    for (const loop of orphanedCli) {
      await need().appendAudit("info", "loop.stop", `Closed out CLI loop "${loopLabel(loop)}" whose session had ended.`, {
        id: loop.id,
        iterations: loop.iterations,
        origin: loop.origin
      });
    }
    for (const loop of interrupted) {
      await need().appendAudit("warning", "loop.error", `Loop "${loopLabel(loop)}" was interrupted by the app closing.`, {
        id: loop.id,
        iterations: loop.iterations
      });
    }
  }

  loopSchedulerStarted = true;
  scheduleNextLoopTick();
}
