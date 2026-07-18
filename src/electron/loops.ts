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
  /** Set by "/loop --every 15m". Overrides the delay the model asks for, so the
   *  loop runs on the user's schedule instead of its own.
   *
   *  It overrides the GAP ONLY. The model is still asked to decide whether to
   *  continue, and silence still stops the loop. A fixed interval must not be
   *  allowed to become a way to make a loop run forever: that would turn the
   *  one governing rule of this feature into an option. */
  fixedIntervalSeconds?: number;
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
  // THE GOAL COMES FIRST AND ALONE. Routing classifies chat-vs-build from the
  // prompt text, so whatever leads it decides what Metis thinks it was asked
  // to do. An earlier version opened with "You are iteration 1 of 3 in an
  // autonomous Metis loop" and buried the goal below it; a question about the
  // code routed as a build and rewrote the file. Scaffolding goes underneath,
  // kept short so the goal stays the dominant signal.
  const lines: string[] = [loop.goal, ""];

  if (loop.history.length) {
    lines.push(`(Loop turn ${loop.iterations + 1} of ${loop.maxIterations}. Already done, do not redo:`);
    for (const entry of loop.history.slice(-6)) {
      lines.push(`- ${entry.error ? `turn ${entry.index} failed: ${entry.error}` : entry.summary || "(nothing recorded)"}`);
    }
    lines.push(")", "");
  } else {
    lines.push(`(Loop turn 1 of ${loop.maxIterations}.)`, "");
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
