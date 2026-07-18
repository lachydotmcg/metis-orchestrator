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
  status: LoopStatus;
  iterations: number;
  maxIterations: number;
  createdAt: string;
  expiresAt: string;
  nextWakeAt?: string;
  lastReason?: string;
  stoppedReason?: string;
  history: LoopIterationRecord[];
}

export interface LoopDecision {
  decision: "continue" | "stop";
  delaySeconds?: number;
  reason?: string;
}

/** The instruction block appended to every wake prompt. Written to make
 *  stopping the easy path: the model is told plainly that saying nothing ends
 *  the loop, so the lazy failure is the safe one. */
export function loopDecisionPromptBlock(): string {
  return [
    "## Ending your turn",
    "",
    "When you have finished this turn's work, decide whether the loop should continue.",
    "Answer with a fenced block, exactly one JSON object, as the LAST thing in your reply:",
    "",
    "```metis-loop",
    '{ "decision": "continue", "delaySeconds": 900, "reason": "waiting for the build to finish" }',
    "```",
    "",
    "or",
    "",
    "```metis-loop",
    '{ "decision": "stop", "reason": "the goal is met" }',
    "```",
    "",
    "Rules:",
    `- delaySeconds is clamped to between ${LOOP_MIN_DELAY_SECONDS} and ${LOOP_MAX_DELAY_SECONDS}. Pick it from what you are actually waiting for.`,
    "- Stop as soon as the goal is met, or as soon as you can tell that continuing cannot make progress. Stopping early is correct behaviour, not giving up.",
    "- If you omit the block, or it does not parse, THE LOOP STOPS. Continuing is something you have to ask for."
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
    if (decision === "stop") return { decision, reason };
    return { decision, delaySeconds: clampLoopDelay(coerceSeconds(record.delaySeconds)), reason };
  } catch {
    return null;
  }
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
export function clampLoopDelay(seconds: number): number {
  if (Number.isNaN(seconds)) return LOOP_MIN_DELAY_SECONDS;
  if (seconds === Number.POSITIVE_INFINITY) return LOOP_MAX_DELAY_SECONDS;
  if (seconds === Number.NEGATIVE_INFINITY) return LOOP_MIN_DELAY_SECONDS;
  return Math.min(LOOP_MAX_DELAY_SECONDS, Math.max(LOOP_MIN_DELAY_SECONDS, Math.round(seconds)));
}

/** Every reason a loop must not tick, in one place, so the tick path and the
 *  scheduler cannot disagree about whether a loop is alive. */
export function loopTerminalReason(loop: LoopRecord, now: Date): string | null {
  if (loop.status === "stopped") return "stopped";
  if (loop.status === "exhausted") return "exhausted";
  if (loop.status === "failed") return "failed";
  if (loop.iterations >= loop.maxIterations) return `reached its ${loop.maxIterations}-iteration limit`;
  if (new Date(loop.expiresAt) <= now) return `passed its ${LOOP_MAX_AGE_HOURS}-hour wall-clock limit`;
  return null;
}

/** Builds the prompt for one wakeup: the original goal verbatim, where the loop
 *  is up to, and what it already tried. The history digest is what stops
 *  iteration 4 from redoing iteration 2 - without it a woken run is a prompt
 *  with amnesia. */
export function composeWakePrompt(loop: LoopRecord): string {
  const iteration = loop.iterations + 1;
  const lines: string[] = [
    `You are iteration ${iteration} of ${loop.maxIterations} in an autonomous Metis loop.`,
    "",
    "## The goal, as originally given",
    loop.goal,
    ""
  ];

  if (loop.history.length) {
    lines.push("## What earlier iterations did");
    for (const entry of loop.history.slice(-6)) {
      const outcome = entry.error ? `failed: ${entry.error}` : entry.summary || "(no summary recorded)";
      lines.push(`- Iteration ${entry.index}: ${outcome}`);
    }
    lines.push("");
    lines.push("Do not repeat work that is already done. Build on it or verify it.");
    lines.push("");
  } else {
    lines.push("This is the first iteration. Start the work.");
    lines.push("");
  }

  if (loop.projectPath) {
    lines.push(`## Project`, loop.projectPath, "");
  }

  lines.push(
    `You have ${loop.maxIterations - loop.iterations} iteration(s) left including this one. Do real work this turn rather than only planning, because a plan with no iterations left to execute it is worth nothing.`,
    ""
  );
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
