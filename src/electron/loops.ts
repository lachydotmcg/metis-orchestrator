/**
 * Metis Loops, phase 1 (docs/LOOPS.md).
 *
 * A loop is a goal Metis works on across several turns, deciding for itself
 * whether to keep going. This module holds the parts where getting it wrong is
 * expensive: parsing the model's continue-or-stop decision, and clamping that
 * decision to limits the model cannot argue its way past.
 *
 * The governing rule, and the reason the parser is shaped the way it is:
 * CONTINUING IS AN EXPLICIT ACT, AND SILENCE STOPS THE LOOP. A model that
 * forgets to answer, answers in prose, emits malformed JSON, or crashes
 * mid-sentence all land in the same place - the loop ends. The failure mode
 * being designed out is a loop that runs all night because nobody said stop,
 * which is the one bug in this feature that costs real money while the user is
 * asleep. Every ambiguity therefore resolves toward stopping.
 *
 * Deliberate deviation from the design doc: LOOPS.md proposed adding
 * schedule_wakeup/stop_loop to ManagerActionKind. They are parsed here as a
 * dedicated ```metis-loop block instead, because a loop tick runs through
 * runSessionTracked rather than the Manager chat, so extractManagerActions is
 * not even in the path - and a schedule_wakeup proposed by the Manager, which
 * has no loop to re-arm, would be meaningless. This keeps the SHAPE the doc
 * cared about (fenced block, validated, never throws) without giving the
 * Manager two actions it cannot perform.
 */

import { formatStepChain, type LoopStepPosition } from "../shared/loop-command.js";

/** Hard ceiling on iterations, even if a caller asks for more. A loop that
 *  needs 50 turns is a loop that has misunderstood its goal. */
export const LOOP_MAX_ITERATIONS_CEILING = 25;

/** Floor on the model's requested delay. Without this a confused model that
 *  answers delaySeconds: 0 spins a hot loop of real inference calls. */
export const LOOP_MIN_DELAY_SECONDS = 60;

/** Ceiling on a single sleep, so a loop cannot park itself past the horizon
 *  where the user has forgotten it exists. */
export const LOOP_MAX_DELAY_SECONDS = 3600;

/** Wall-clock ceiling, counted from creation. Iterations alone do not bound a
 *  loop whose every turn is a slow build. */
export const LOOP_MAX_AGE_HOURS = 12;

export type LoopStatus = "sleeping" | "running" | "stopped" | "exhausted" | "failed";

/** How many helpers one turn may ask for. Three is enough to parallelise a
 *  real job; more is a model misunderstanding its goal, the same reasoning as
 *  the iteration ceiling. */
export const LOOP_MAX_SPAWN_PER_TURN = 3;

/** Lifetime ceiling on helpers across the whole loop, enforced at launch time
 *  in main.ts. A loop that wants a fourth round of three helpers has almost
 *  certainly stopped converging, and every helper is a real model call. */
export const LOOP_MAX_SPAWNED_TOTAL = 9;

/** One helper a loop turn asked for (docs/LOOPS.md phase 2). The record is
 *  the visibility story: a helper that ran while nobody watched must be
 *  listed, with what it was asked and how it ended. */
export interface LoopSpawnedAgent {
  name: string;
  task: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "done" | "failed";
  /** One-line digest of what the helper produced, replayed into the loop's
   *  next wake prompt so the main line of work can build on it. */
  summary?: string;
  /** The helper's own conversation — helpers deliberately do NOT write into
   *  the loop's conversation, so two concurrent runs never interleave one
   *  transcript. */
  conversationId?: string;
}

/** A spawn request as parsed out of the decision block, before launch. */
export interface LoopSpawnRequest {
  name: string;
  task: string;
}

export interface LoopIterationRecord {
  index: number;
  at: string;
  /** Compact summary of what that turn actually did, replayed on later
   *  wakeups so an iteration can see its own history rather than repeating it. */
  summary: string;
  decision: "continue" | "stop" | "silent";
  reason?: string;
  error?: string;
}

export interface LoopRecord {
  id: string;
  goal: string;
  conversationId?: string;
  projectPath?: string;
  /** Which surface created this loop, and therefore which surface is allowed to
   *  resume it after a restart. A loop is resumed only by something that can
   *  also SHOW it and stop it: the app has the Loops panel, so app loops re-arm
   *  on launch. The CLI drives its loops in the foreground and cannot show
   *  anything once its process is gone, so a cli loop left sleeping by a
   *  Ctrl-C, a timeout or a crash is closed out on next launch rather than
   *  silently resumed. Without this, killing the CLI mid-loop plants an
   *  autonomous run that fires inside the desktop app hours later, which the
   *  user never created and would not think to look for. */
  origin: "app" | "cli";
  /** Inherited at creation and never re-read from settings, so a loop cannot
   *  gain permissions it did not start with by the user changing a global. */
  permissionMode: string;
  /** Recorded at creation when nothing available is likely to drive this loop
   *  well. Shown in the panel and in the confirmation, never used to refuse:
   *  see assessLoopCapability for why this warns rather than blocks. */
  capabilityWarning?: string;
  /** Set by "/loop --every 15m". Overrides the delay the model asks for, so the
   *  loop runs on the user's schedule instead of its own.
   *
   *  It overrides the GAP ONLY. The model is still asked to decide whether to
   *  continue, and silence still stops the loop. A fixed interval must not be
   *  allowed to become a way to make a loop run forever: that would turn the
   *  one governing rule of this feature into an option. */
  fixedIntervalSeconds?: number;
  /** Set by "/loop --budget 200k". Token ceiling (input + output) summed from
   *  the usage ledger's per-loop attribution; the loop settles as `exhausted`
   *  once its spend reaches it. Undefined means no token ceiling — the
   *  iteration cap and wall-clock limit still bound the loop either way. */
  budgetTokens?: number;
  status: LoopStatus;
  iterations: number;
  maxIterations: number;
  createdAt: string;
  expiresAt: string;
  nextWakeAt?: string;
  lastReason?: string;
  stoppedReason?: string;
  history: LoopIterationRecord[];
  /** Helpers this loop has launched, newest last (docs/LOOPS.md phase 2).
   *  Persisted so the panel can show what ran unattended, and so the total
   *  cap survives restarts. */
  spawnedAgents?: LoopSpawnedAgent[];
  /** Flowchart loop (docs/FLOWCHART_LOOPS_DESIGN.md): the ordered chain from
   *  "--steps". A position is one step (string) or a parallel GROUP
   *  (string[]) whose members run side by side as phase 2A helpers before
   *  the chain moves on. Absent on a plain goal loop. */
  steps?: LoopStepPosition[];
  /** Program counter into `steps`, 0-based, advanced on every continue and
   *  wrapping implicitly — a loop that reaches the end of its chain starts
   *  again, because it is a loop. Meaningless when `steps` is absent. */
  stepIndex?: number;
  /** The parallel group currently in flight, when the chain is parked on a
   *  group position: which helper names were launched and when. Cleared the
   *  moment every member has finished and the counter advances. Its
   *  presence is what tells a wake apart from a fresh arrival at the group. */
  currentGroup?: { startedAt: string; names: string[] };
}

/** What a flowchart loop should do THIS turn, or null for a plain goal loop.
 *  The modulo is the implicit loop-back: no stored stepIndex can point past
 *  the chain, even one written by an older or foreign build. */
export type CurrentLoopStep =
  | { kind: "single"; index: number; text: string; total: number }
  | { kind: "group"; index: number; members: string[]; total: number };

export function currentLoopStep(loop: LoopRecord): CurrentLoopStep | null {
  if (!loop.steps?.length) return null;
  const index = ((loop.stepIndex ?? 0) % loop.steps.length + loop.steps.length) % loop.steps.length;
  const position = loop.steps[index];
  if (Array.isArray(position)) {
    // A malformed single-member "group" (older data, foreign writer) behaves
    // as the single step it really is rather than paying helper machinery.
    if (position.length === 1) return { kind: "single", index, text: position[0], total: loop.steps.length };
    return { kind: "group", index, members: position, total: loop.steps.length };
  }
  return { kind: "single", index, text: position, total: loop.steps.length };
}

export interface LoopDecision {
  decision: "continue" | "stop";
  delaySeconds?: number;
  reason?: string;
  /** Helpers the turn asked to run before its next wake (phase 2). Only ever
   *  present on a "continue": spawning helpers and stopping in the same
   *  breath is a contradiction, and the parser drops spawn on stop. */
  spawn?: LoopSpawnRequest[];
}

/** The instruction block appended to every wake prompt. Written to make
 *  stopping the easy path: the model is told plainly that saying nothing ends
 *  the loop, so the lazy failure is the safe one. */
/** Deliberately terse, and deliberately free of words like "build", "make" or
 *  "create". Metis classifies chat-vs-build from the prompt text, and the first
 *  live loop proved how badly that interacts with a chatty scaffold: a
 *  read-only goal ("how many functions does app.js define?") wrapped in an
 *  earlier, longer version of this block routed to the BUILD pipeline and
 *  rewrote the file down from 171 lines to 10. The example reason said
 *  "waiting for the build to finish", and that one word was enough. Every line
 *  here is therefore both short, so the goal stays the dominant signal, and
 *  neutral, so it cannot be read as a request to write anything. */
export function loopDecisionPromptBlock(): string {
  return [
    "---",
    "End your reply with this fenced block, and nothing after it:",
    "",
    "```metis-loop",
    '{ "decision": "continue", "delaySeconds": 900, "reason": "why you need another turn" }',
    "```",
    "",
    `Use "stop" instead of "continue" once the goal is met or once another turn cannot help. delaySeconds is clamped to ${LOOP_MIN_DELAY_SECONDS}-${LOOP_MAX_DELAY_SECONDS}.`,
    // Phase 2 helpers. One line, kept SHORT and neutral (no build/make/create
    // — see the routing-hazard note above; the wake prompt has a length bound
    // in suite 01 so the goal stays the dominant signal), continue-only.
    `"continue" may add "spawn": [{ "name": "docs", "task": "..." }] — max ${LOOP_MAX_SPAWN_PER_TURN} parallel helpers, only if the goal splits.`,
    "No block means the loop ends. Continuing is something you have to ask for."
  ].join("\n");
}

/** Parses the trailing ```metis-loop block. Returns null for anything it is
 *  not certain about, which the caller treats as stop. Never throws. */
export function extractLoopDecision(text: string): LoopDecision | null {
  if (typeof text !== "string" || !text.includes("metis-loop")) return null;
  try {
    // Last block wins: a model that reasons out loud may show an example
    // earlier in its reply, and the decision is the one it ends on.
    const matches = [...text.matchAll(/```metis-loop\s*([\s\S]*?)```/g)];
    if (!matches.length) return null;
    const raw = matches[matches.length - 1][1].trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const decision = record.decision;
    if (decision !== "continue" && decision !== "stop") return null;
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : undefined;
    // Spawn is DROPPED on a stop rather than honoured: "run helpers and also
    // stop" is a contradiction, and the resolution rule is the same one the
    // whole parser follows — the conservative reading wins.
    if (decision === "stop") return { decision, reason };
    const spawn = parseSpawnRequests(record.spawn);
    return { decision, delaySeconds: clampLoopDelay(coerceSeconds(record.delaySeconds)), reason, ...(spawn ? { spawn } : {}) };
  } catch {
    return null;
  }
}

/** Validates a decision block's "spawn" array (phase 2). Malformed entries
 *  are dropped individually rather than poisoning the whole decision: the
 *  continue/stop verdict is the load-bearing part of the block, and a typo'd
 *  helper must not turn a working loop's continue into a silent stop. Caps at
 *  LOOP_MAX_SPAWN_PER_TURN, dedupes by name, and returns undefined when
 *  nothing valid survives so callers can spread it away cleanly. */
export function parseSpawnRequests(value: unknown): LoopSpawnRequest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const requests: LoopSpawnRequest[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const task = typeof record.task === "string" ? record.task.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    if (!name || !task) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ name, task });
    if (requests.length >= LOOP_MAX_SPAWN_PER_TURN) break;
  }
  return requests.length ? requests : undefined;
}

/** Models quote numbers constantly, and "900" silently flooring to the 60s
 *  minimum is a fifteen-fold speed-up nobody asked for. Accepting a numeric
 *  string is safe because the result is clamped either way. Anything genuinely
 *  unreadable becomes NaN and the clamp resolves it to the minimum. */
function coerceSeconds(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

/** A true clamp: ±Infinity lands on the matching bound rather than being
 *  treated as garbage. Only NaN, which cannot be ordered against anything,
 *  falls back to the minimum. */
/** Below this many billion parameters, a local model follows the loop protocol
 *  unreliably: it does the work and then forgets to say whether to continue, or
 *  answers in prose. Silence stops the loop, so the failure is safe but wasteful
 *  - you get one turn of a job that needed six. A heuristic, and named as one. */
export const LOOP_CAPABLE_LOCAL_PARAMS_B = 7;

/** Reads the parameter count out of an Ollama tag: "qwen3:8b" is 8,
 *  "qwen3:1.7b" is 1.7, "gemma4:e4b" is 4. Returns null for tags that do not
 *  encode a size at all, like a quantisation-suffixed GGUF path, since guessing
 *  from those would be worse than admitting we cannot tell. */
export function ollamaParamBillions(tag: string): number | null {
  if (typeof tag !== "string") return null;
  const match = tag.toLowerCase().match(/:[a-z]*?(\d+(?:\.\d+)?)\s*b\b/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface LoopCapability {
  /** False only when we are confident nothing available can drive a loop well. */
  capable: boolean;
  /** Plain-English warning shown to the user. Undefined when there is nothing
   *  worth saying. */
  warning?: string;
}

/**
 * Whether anything on this machine is likely to drive a loop reliably.
 *
 * docs/LOOPS.md closes phase 1 on this, and it is deliberately a WARNING rather
 * than a refusal. Metis is local-first and the doc's own argument is that a loop
 * is the one place free local inference is structurally enabling: nobody runs 25
 * autonomous iterations on a metered API for fun, but on your own hardware it
 * costs electricity. A gate that only passed cloud models would invert the
 * product's own case for the feature. So it says the true thing and lets the
 * owner decide.
 *
 * It cannot know exactly which model will answer, because a loop routes through
 * the Auto Router at each tick. It reports on what is AVAILABLE, which is the
 * honest scope: "nothing you have is likely to do this well" is a useful thing
 * to hear before starting, and "your 8b will probably cope" is not a promise.
 */
export function assessLoopCapability(input: { installedLocal: string[]; cloudConfigured: boolean }): LoopCapability {
  if (input.cloudConfigured) return { capable: true };

  const sized = input.installedLocal.map((tag) => ({ tag, params: ollamaParamBillions(tag) }));
  const bigEnough = sized.filter((entry) => entry.params !== null && entry.params >= LOOP_CAPABLE_LOCAL_PARAMS_B);
  if (bigEnough.length) return { capable: true };

  if (!input.installedLocal.length) {
    return {
      capable: false,
      warning: "No models are available, so this loop cannot run. Pull a local model with Ollama, or add a provider key in Settings."
    };
  }

  // Unknown sizes are treated as capable-but-unverified rather than failing,
  // because refusing a model we simply could not measure would block perfectly
  // good custom builds.
  const unknown = sized.filter((entry) => entry.params === null);
  if (unknown.length) {
    return {
      capable: true,
      warning: `Could not tell how large ${unknown.length === 1 ? unknown[0].tag : "some of your models"} is, so this loop may or may not follow the protocol well. Watch the first turn.`
    };
  }

  const largest = sized.reduce((best, entry) => ((entry.params ?? 0) > (best.params ?? 0) ? entry : best), sized[0]);
  return {
    capable: true,
    warning: `Your largest local model is ${largest.tag}, under the ~${LOOP_CAPABLE_LOCAL_PARAMS_B}B where models reliably decide when to STOP. The loop will run, but it may do one turn and end early rather than finishing the job. Adding a provider key gives it something stronger to escalate to.`
  };
}

/** Injected so this module keeps no import edge back into main.ts. Same shape
 *  and same reasoning as FollowupInvoke in followups.ts. */
export type LoopDecisionInvoke = (prompt: string) => Promise<{ output: string; source: string }>;

/**
 * Asks, as a SEPARATE small call, whether the loop should continue.
 *
 * This exists because of a specific live failure. A loop whose goal is real
 * work ("add a JSDoc comment above each function, two per turn") correctly
 * routes to the build/edit pipeline, and that pipeline's reply is a pipeline
 * SUMMARY ("I ran this through the build pipeline and wrote 1 file"), not a
 * model answer. There is nowhere for a metis-loop block to come from, so every
 * working loop emitted no decision and stopped after exactly one turn. The loop
 * did the work and then always gave up, which is the worst possible version of
 * this feature: it looks like it works and quietly does one twelfth of the job.
 *
 * Separating the WORK from the DECISION fixes it generally rather than for one
 * pipeline. It also matches what followups.ts already learned the hard way:
 * small local models collapse when a single response has to carry both a task
 * and a piece of protocol. One job per call.
 *
 * SILENCE STILL STOPS THE LOOP. This is a second chance to say continue, never
 * a default toward continuing. Any failure, any unparseable answer, any
 * placeholder result returns null and the caller ends the loop.
 */
export async function decideLoopContinuation(
  invoke: LoopDecisionInvoke,
  input: { goal: string; whatHappened: string; turnsLeft: number }
): Promise<LoopDecision | null> {
  try {
    const prompt = [
      "A background task just finished one turn of work. Decide whether it needs another turn.",
      "",
      "THE GOAL:",
      input.goal,
      "",
      "WHAT THIS TURN DID:",
      input.whatHappened || "(nothing was reported)",
      "",
      `Turns remaining if you continue: ${input.turnsLeft}`,
      "",
      "Answer with ONE line and nothing else:",
      "  CONTINUE <seconds> <short reason>     if the goal is not finished yet",
      "  STOP <short reason>                   if the goal is met, or another turn cannot help",
      "",
      "Example: CONTINUE 60 four functions still need comments",
      "Example: STOP every function now has a comment"
    ].join("\n");

    const result = await invoke(prompt);
    // A placeholder is main.ts's stub for "no key configured" / "Ollama is not
    // running". Parsing it as a decision would turn an outage into a running loop.
    if (!result || result.source === "placeholder") return null;

    const cleaned = result.output
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      // An UNTERMINATED think block is a reasoning trace cut off by the token
      // limit, and deliberation about this exact question reliably contains a
      // line beginning "Continue..." long before any conclusion. Stripping only
      // closed pairs left that raw thinking to be read as the answer.
      .replace(/<think>[\s\S]*$/i, "");

    const candidates = cleaned
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => /^(continue|stop)\b/i.test(entry))
      // Small models echo the option menu before answering, and the menu lists
      // CONTINUE first, so an echo used to win outright. A line still carrying
      // the prompt's placeholders is a quotation, not a decision.
      .filter((entry) => !/<seconds>|<short reason>/i.test(entry));

    if (!candidates.length) return null;

    // AMBIGUITY RESOLVES TOWARD STOPPING, the same rule extractLoopDecision
    // follows. Any stop line wins, even alongside a continue: we cannot tell
    // which the model meant, and stopping is the recoverable mistake. This also
    // catches prose like "Continue? No, the work is done, so we should stop",
    // which begins with the word continue and means the opposite.
    const stopLine = candidates.find((entry) => /^stop\b/i.test(entry));
    const contradicted = candidates.find((entry) => /^continue\b/i.test(entry) && /\bstop\b/i.test(entry));
    if (stopLine || contradicted) {
      const source = stopLine ?? "";
      const reason = source.replace(/^stop\b[\s:.-]*/i, "").trim();
      return { decision: "stop", reason: reason || undefined };
    }

    // Otherwise the LAST continue line, mirroring extractLoopDecision's
    // "the decision is the one it ends on".
    const line = candidates[candidates.length - 1];
    // The unit matters. Reading the bare number as seconds turned
    // "CONTINUE 5 minutes" into 5 seconds, which the clamp then floored to 60:
    // a model asking for a five minute gap silently got one minute.
    const match = line.match(/^continue\b[\s:.-]*(?:in\s+)?(\d+(?:\.\d+)?)?\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?\b\s*(.*)$/i);
    if (!match) return null;
    const rawNumber = match[1] ? Number(match[1]) : null;
    const unit = (match[2] ?? "").toLowerCase();
    const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
    const seconds = rawNumber === null ? LOOP_MIN_DELAY_SECONDS : rawNumber * multiplier;
    const reason = (match[3] ?? "").trim();
    return { decision: "continue", delaySeconds: clampLoopDelay(seconds), reason: reason || undefined };
  } catch {
    return null;
  }
}

export function clampLoopDelay(seconds: number): number {
  if (Number.isNaN(seconds)) return LOOP_MIN_DELAY_SECONDS;
  if (seconds === Number.POSITIVE_INFINITY) return LOOP_MAX_DELAY_SECONDS;
  if (seconds === Number.NEGATIVE_INFINITY) return LOOP_MIN_DELAY_SECONDS;
  return Math.min(LOOP_MAX_DELAY_SECONDS, Math.max(LOOP_MIN_DELAY_SECONDS, Math.round(seconds)));
}

/** Every reason a loop must not tick, in one place, so the tick path and the
 *  scheduler cannot disagree about whether a loop is alive.
 *
 *  `spentTokens` is the loop's ledger-attributed spend (input + output),
 *  passed in by the caller because this function stays synchronous and the
 *  ledger read is async. Callers that did not measure pass undefined and the
 *  budget check simply does not run that time — the tick path measures before
 *  AND after each turn, so a budget can be missed by at most the turn already
 *  in flight, never by a scheduler that forgot to look. */
export function loopTerminalReason(loop: LoopRecord, now: Date, spentTokens?: number): string | null {
  if (loop.status === "stopped") return "stopped";
  if (loop.status === "exhausted") return "exhausted";
  if (loop.status === "failed") return "failed";
  if (loop.iterations >= loop.maxIterations) return `reached its ${loop.maxIterations}-iteration limit`;
  if (new Date(loop.expiresAt) <= now) return `passed its ${LOOP_MAX_AGE_HOURS}-hour wall-clock limit`;
  if (
    typeof loop.budgetTokens === "number" &&
    loop.budgetTokens > 0 &&
    typeof spentTokens === "number" &&
    spentTokens >= loop.budgetTokens
  ) {
    return `spent its ${loop.budgetTokens.toLocaleString("en-US")}-token budget (${spentTokens.toLocaleString("en-US")} used)`;
  }
  return null;
}

/** Builds the prompt for one wakeup: the original goal verbatim, where the loop
 *  is up to, and what it already tried. The history digest is what stops
 *  iteration 4 from redoing iteration 2 - without it a woken run is a prompt
 *  with amnesia. */
export function composeWakePrompt(loop: LoopRecord): string {
  // THE GOAL COMES FIRST AND ALONE. Routing classifies chat-vs-build from the
  // prompt text, so whatever leads it decides what Metis thinks it was asked
  // to do. An earlier version opened with "You are iteration 1 of 3 in an
  // autonomous Metis loop" and buried the goal below it; a question about the
  // code routed as a build and rewrote the file. Scaffolding goes underneath,
  // kept short so the goal stays the dominant signal.
  //
  // A flowchart loop's CURRENT STEP is its goal for this turn, so the step
  // leads instead (docs/FLOWCHART_LOOPS_DESIGN.md — the step list is exactly
  // the class of scaffolding that once steered a run, so the cycle summary
  // sits below, terse, one line).
  const step = currentLoopStep(loop);
  // A group position never composes a wake prompt — the tick launches its
  // members as helpers instead of running a work turn — so the defensive
  // join below only ever renders if a caller slips. Single steps lead.
  const lines: string[] = [step ? (step.kind === "single" ? step.text : step.members.join(" and ")) : loop.goal, ""];
  if (step) {
    lines.push(`(Step ${step.index + 1} of ${step.total} in a repeating cycle: ${formatStepChain(loop.steps!)}.)`, "");
  }

  if (loop.history.length) {
    lines.push(`(Loop turn ${loop.iterations + 1} of ${loop.maxIterations}. Already done, do not redo:`);
    for (const entry of loop.history.slice(-6)) {
      lines.push(`- ${entry.error ? `turn ${entry.index} failed: ${entry.error}` : entry.summary || "(nothing recorded)"}`);
    }
    lines.push(")", "");
  } else {
    lines.push(`(Loop turn 1 of ${loop.maxIterations}.)`, "");
  }

  // Phase 2: what the helpers produced, so the main line of work builds on
  // them instead of redoing them. Same neutral wording rule as everything
  // else here — this is scaffolding, and scaffolding is a routing signal.
  if (loop.spawnedAgents?.length) {
    lines.push("(Helpers you already asked for:");
    for (const agent of loop.spawnedAgents.slice(-6)) {
      const state = agent.status === "running" ? "still going" : agent.status;
      lines.push(`- ${agent.name} (${state})${agent.summary ? `: ${agent.summary}` : ""}`);
    }
    lines.push(")", "");
  }

  lines.push(loopDecisionPromptBlock());
  return lines.join("\n");
}

/** One-line digest of a turn, stored in history. Kept short on purpose: this is
 *  replayed into every later prompt, so a verbose summary costs tokens on every
 *  remaining iteration. */
export function summariseTurn(assistantText: string, limit = 240): string {
  const cleaned = (assistantText ?? "")
    .replace(/```metis-loop[\s\S]*?```/g, "")
    .replace(/```[\s\S]*?```/g, "(code)")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "(no reply text)";
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}
