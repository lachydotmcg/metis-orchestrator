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

import { formatStepChain, stepInstruction, stepVariableName, stepVariableRefs, type LoopGate, type LoopStepPosition } from "../shared/loop-command.js";
import { findBlock } from "../shared/model-blocks.js";
import type { WalkthroughFile, WalkthroughRouting } from "../shared/walkthrough.js";

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

export type LoopStatus = "sleeping" | "running" | "stopped" | "exhausted" | "failed" | "blocked";

/** How many helpers one turn may ask for. Three is enough to parallelise a
 *  real job; more is a model misunderstanding its goal, the same reasoning as
 *  the iteration ceiling. */
export const LOOP_MAX_SPAWN_PER_TURN = 3;

/** Lifetime ceiling on helpers across the whole loop, enforced at launch time
 *  in main.ts. A loop that wants a fourth round of three helpers has almost
 *  certainly stopped converging, and every helper is a real model call. */
export const LOOP_MAX_SPAWNED_TOTAL = 9;

/** How much of a turn's output is carried to the step that runs next.
 *
 *  Generous compared with the 240-char history digest, because this is read
 *  once by the following step rather than replayed for the rest of the loop's
 *  life. Bounded all the same: a chain that hands its whole transcript forward
 *  grows its own prompt every cycle until the budget stops it. */
export const LOOP_ARTIFACT_LIMIT = 3000;

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
  /** Set when this helper was launched as a member of a parallel step GROUP,
   *  to the group's startedAt. Absent for a helper a decision block asked for.
   *
   *  This is what makes the wake digest readable on the second pass through a
   *  chain: without it, a step that consumes helper output sees a flat
   *  loop-lifetime window and cannot tell this cycle's reviewers from the last
   *  cycle's. See helpersForWakePrompt. */
  groupStartedAt?: string;
}

/** A spawn request as parsed out of the decision block, before launch. */
export interface LoopSpawnRequest {
  name: string;
  task: string;
  /** Material the helper needs in order to do the task at all — the previous
   *  step's output, when this helper is a member of a step group.
   *
   *  Kept separate from `task` on purpose. `task` is what the helper is ROUTED
   *  on, and routing classifies from prompt text: fold a draft full of code
   *  into it and "review this" starts routing as a build. The context lands in
   *  the prompt only. Same split, and the same reason, as routingPrompt in the
   *  main tick. */
  context?: string;
}

/** One checkable outcome from a turn: what ran, and whether it worked. */
export interface LoopEvidence {
  label: string;
  status: "complete" | "warning" | "error";
  exitCode?: number;
  /** The tail of stderr on a failure, trimmed from the FRONT. Opposite to
   *  captureArtifact's middle-trim, and for the same reason applied to a
   *  different shape: a stack trace's useful line is the last one, so keeping
   *  the head would keep the part that says nothing. */
  detail?: string;
}

/** How much failure output travels forward. Small on purpose: this is replayed
 *  into a prompt, and a 200-line stack trace crowds out the goal. */
export const LOOP_EVIDENCE_DETAIL_LIMIT = 400;

/** How many operations count as evidence in one turn. */
export const LOOP_EVIDENCE_MAX = 6;

/** Turns a turn's operations into evidence the next turn can act on.
 *
 *  The rule is deliberately narrow: an operation counts only if it CHECKED
 *  something. A command has an exit code, and a browser check collects console
 *  errors; both can fail and say so. A file write cannot — it reports that
 *  something happened, not that it worked, and treating it as evidence would
 *  let a loop "verify" itself by writing a file.
 *
 *  Kept pure and shaped around the fields AgentOperation already has, so it can
 *  be tested without a run. */
export function evidenceFromOperations(
  operations: ReadonlyArray<{
    label?: string;
    status?: string;
    exitCode?: number;
    stderr?: string;
    consoleErrors?: string[];
  }>
): LoopEvidence[] {
  if (!Array.isArray(operations)) return [];
  const evidence: LoopEvidence[] = [];
  for (const operation of operations) {
    const checked = typeof operation?.exitCode === "number" || (Array.isArray(operation?.consoleErrors) && operation.consoleErrors.length > 0);
    if (!checked) continue;
    const status = operation.status === "error" || operation.status === "warning" ? operation.status : "complete";
    const failureText = status === "complete" ? "" : [operation.stderr ?? "", ...(operation.consoleErrors ?? [])].join("\n").trim();
    evidence.push({
      label: (operation.label ?? "(unnamed step)").slice(0, 120),
      status,
      ...(typeof operation.exitCode === "number" ? { exitCode: operation.exitCode } : {}),
      ...(failureText ? { detail: trimToTail(failureText, LOOP_EVIDENCE_DETAIL_LIMIT) } : {})
    });
    if (evidence.length >= LOOP_EVIDENCE_MAX) break;
  }
  return evidence;
}

/** How many files one turn reports having written. A turn that rewrote 200
 *  files is a turn whose walkthrough row nobody reads; the count is stated
 *  either way so the truncation cannot pass for the whole list. */
export const LOOP_FILES_MAX = 20;

/** Which files a turn wrote, for the walkthrough.
 *
 *  Deliberately NOT evidence (see evidenceFromOperations): a write reports that
 *  something happened, not that it worked. This is the other half of the same
 *  record — the reader wants both "what did it touch" and "what did it prove",
 *  and conflating them is what lets a loop look verified because it was busy. */
export function filesFromOperations(
  operations: ReadonlyArray<{ kind?: string; target?: string; label?: string; addedLines?: number; removedLines?: number }>
): WalkthroughFile[] {
  if (!Array.isArray(operations)) return [];
  const files: WalkthroughFile[] = [];
  for (const operation of operations) {
    if (operation?.kind !== "file_edit" && operation?.kind !== "file_create") continue;
    const path = (operation.target ?? operation.label ?? "").trim();
    if (!path) continue;
    files.push({
      path: path.slice(0, 200),
      kind: operation.kind === "file_create" ? "create" : "edit",
      ...(typeof operation.addedLines === "number" ? { addedLines: operation.addedLines } : {}),
      ...(typeof operation.removedLines === "number" ? { removedLines: operation.removedLines } : {})
    });
    if (files.length >= LOOP_FILES_MAX) break;
  }
  return files;
}

/** Keeps the END of a string. See LoopEvidence.detail for why. */
export function trimToTail(text: string, limit: number): string {
  const cleaned = (text ?? "").trim();
  if (cleaned.length <= limit) return cleaned;
  return `…${cleaned.slice(cleaned.length - limit + 1)}`;
}

export interface LoopIterationRecord {
  index: number;
  at: string;
  /** Compact summary of what that turn actually did, replayed on later
   *  wakeups so an iteration can see its own history rather than repeating it. */
  summary: string;
  decision: "continue" | "stop" | "silent" | "blocked";
  reason?: string;
  error?: string;
  /** What the turn's operations actually PROVED, carried into the next turn's
   *  prompt so the loop can react to an outcome rather than to its own prose.
   *
   *  This is the whole feedback channel and it needed no new collection: an
   *  AgentOperation already carries status, exitCode, stdout, stderr and
   *  consoleErrors, and runSessionTracked already returns them on the run. The
   *  tick simply read assistantText off that same object and dropped the rest. */
  evidence?: LoopEvidence[];
  /** What the turn actually PRODUCED, kept whole enough to be worked on — code
   *  fences intact, unlike `summary`, which collapses them to "(code)".
   *
   *  `summary` and `artifact` answer different questions and both are needed.
   *  The summary is the anti-redo reminder ("already done, do not redo") and is
   *  replayed for the rest of the loop's life, so it has to stay cheap. The
   *  artifact is the handoff to the NEXT step only, so it can afford to be
   *  large. A chain whose steps cannot hand each other work is just a list of
   *  unrelated prompts sharing a timer. */
  artifact?: string;
  /** Which chain step this turn ran, when the loop has one. Stored so an
   *  artifact can be ATTRIBUTED: a synthesise step handed three unlabelled
   *  blobs has to guess which is the draft and which is the critique, and
   *  guessing is what carrying them forward was meant to stop. */
  step?: string;
  /** Where this turn was routed and what it cost, captured AT THE TICK.
   *
   *  Every competitor that writes a run report reconstructs it afterwards from
   *  its own tool calls. Metis has the depth the router judged, the model that
   *  answered and the usage it reported as typed values the moment the turn
   *  ends, so the walkthrough's routing trace is a read rather than an
   *  inference (docs/COMPETITIVE_SWEEP.md, shortlist item 1). Stored on the
   *  record rather than joined from the usage ledger at write time because the
   *  ledger keeps only the last 5000 rows and carries no depth. */
  routing?: WalkthroughRouting;
  /** Files this turn wrote. See filesFromOperations for why these are kept
   *  apart from evidence. */
  files?: WalkthroughFile[];
  /** The backup taken before this turn's writes, when it wrote through the
   *  snapshotted path. Recorded per TURN rather than read from the
   *  `lastProjectSnapshot` store key at report time, because that key holds one
   *  slot and every later write overwrites it — by the time a five-turn loop
   *  settles, four of its backups are unnameable from there. */
  snapshot?: { id: string; dir: string };
  /** Who actually answered the continue-or-stop question, when it was asked as
   *  a separate call.
   *
   *  Recorded because the point of asking a DIFFERENT model (see
   *  loopJudgeInvoker) is unverifiable otherwise: a behaviour change nobody can
   *  see is one nobody can check. Absent when the work turn carried its own
   *  decision block — that turn graded itself, and an empty field is the honest
   *  record of that rather than a gap. */
  judgedBy?: { model: string; independent: boolean; note?: string };
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
  /** The conditional edge (docs/FLOWCHART_LOOPS_V2.md piece 1), from
   *  '--gate "synthesise fails -> draft"'. Absent on every chain that did not
   *  ask for one. */
  gate?: LoopGate;
  /** How many times the gate has already sent the chain backwards. Counts up to
   *  `gate.attempts` and then stops firing, so a step that cannot pass makes the
   *  chain slower rather than eternal. Persisted rather than derived: history is
   *  capped and a long loop would lose the early jumps, which would silently
   *  hand the gate a fresh allowance. */
  gateUsed?: number;
  /** Outputs named with "as $name", newest write wins. Keyed lowercase.
   *
   *  This is naming what the artifact channel already carries: a step could
   *  always see the last three outputs, but only positionally ("whatever came
   *  before"), never by name ("the draft"). */
  variables?: Record<string, string>;
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
  decision: "continue" | "stop" | "blocked";
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
    // Three verdicts on one line rather than two lines, because suite 01 bounds
    // the whole wake prompt at 600 characters so the GOAL stays the dominant
    // signal and scaffolding never crowds it out. The third verdict had to earn
    // its place by making the sentence tighter, not longer.
    //
    // "blocked" is phrased as a permission, not a warning: the failure being
    // designed out is a model guessing in order to look finished, because
    // without somewhere to put "I could not check this" both available answers
    // assert an outcome. Wording also avoids build/make/create/write, which the
    // same suite enforces — this block rides on every wake prompt and those
    // words steer routing, the hazard that once turned a counting loop into a
    // rewrite.
    `Use "stop" once the goal is met, or "blocked" if you cannot verify the result or need the user to decide. delaySeconds is clamped to ${LOOP_MIN_DELAY_SECONDS}-${LOOP_MAX_DELAY_SECONDS}.`,
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
  try {
    // Last block wins: a model that reasons out loud may show an example
    // earlier in its reply, and the decision is the one it ends on. That
    // policy is declared on the registry entry rather than encoded in a regex
    // here, so it is findable next to the other block types.
    const found = findBlock(text, "metis-loop");
    if (!found) return null;
    const raw = found.payload;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const decision = record.decision;
    if (decision !== "continue" && decision !== "stop" && decision !== "blocked") return null;
    const reason = typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : undefined;
    // "blocked" is a stop that does not claim success. It settles the loop the
    // same way, so it drops spawn and delay exactly as "stop" does — a loop
    // that cannot proceed must not also leave helpers running behind it.
    if (decision === "blocked") return { decision, reason };
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
 *
 * THE JUDGE IS NOT THE WORKER (docs/COMPETITIVE_SWEEP.md, shortlist item 2).
 * This used to be handed `followupInvokerFor(providerResult)` — the model that
 * had just done the work, grading its own homework, which is exactly the
 * arrangement where a confident wrong answer survives. The caller now supplies
 * an independent judge (see loopJudgeInvoker in main). Two things follow from
 * that and both are in the prompt above:
 *
 *  - The judge is TOLD it did not do the work, because a model handed a
 *    first-person account defaults to accepting it.
 *  - The judge sees the turn's EVIDENCE, not only its prose. "I have added the
 *    comments" is what a model writes whether or not it did; an exit code is
 *    not. Grading against evidence is the whole difference between an
 *    independent judge and a second opinion from the same voice.
 *
 * And it can answer BLOCKED, which finally has a precise definition: *what I
 * was shown does not tell me either way*. Without it the only two answers both
 * assert an outcome, so a judge with no evidence had to invent one.
 */
export async function decideLoopContinuation(
  invoke: LoopDecisionInvoke,
  input: { goal: string; whatHappened: string; turnsLeft: number; evidence?: LoopEvidence[] }
): Promise<LoopDecision | null> {
  try {
    // What the turn PROVED, above what it SAID about itself. A turn's own prose
    // is the thing least worth trusting when the question is whether that turn
    // succeeded: "I have added the comments" is what a model writes whether or
    // not it did. An exit code is not.
    const evidenceLines: string[] = [];
    if (input.evidence?.length) {
      evidenceLines.push("WHAT ACTUALLY RAN, AND HOW IT ENDED:");
      for (const item of input.evidence) {
        const code = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
        evidenceLines.push(`- ${item.label}: ${item.status}${code}${item.detail ? ` — ${item.detail}` : ""}`);
      }
      evidenceLines.push("");
    }

    const prompt = [
      "A background task just finished one turn of work. Decide whether it needs another turn.",
      "You did not do this work. Judge it on what you are shown, not on how confident it sounds.",
      "",
      "THE GOAL:",
      input.goal,
      "",
      "WHAT THIS TURN SAID IT DID:",
      input.whatHappened || "(nothing was reported)",
      "",
      ...evidenceLines,
      `Turns remaining if you continue: ${input.turnsLeft}`,
      "",
      "Answer with ONE line and nothing else:",
      "  CONTINUE <seconds> <short reason>     if the goal is not finished yet",
      "  STOP <short reason>                   if the goal is met, or another turn cannot help",
      "  BLOCKED <short reason>                if what you were shown cannot tell you either way",
      "",
      "Example: CONTINUE 60 four functions still need comments",
      "Example: STOP every function now has a comment",
      "Example: BLOCKED nothing was run that would show whether the tests pass"
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
      .filter((entry) => /^(continue|stop|blocked)\b/i.test(entry))
      // Small models echo the option menu before answering, and the menu lists
      // CONTINUE first, so an echo used to win outright. A line still carrying
      // the prompt's placeholders is a quotation, not a decision.
      .filter((entry) => !/<seconds>|<short reason>/i.test(entry));

    if (!candidates.length) return null;

    // BLOCKED OUTRANKS EVERYTHING, including stop. Both halt the loop, so this
    // is not about safety — it is about which claim is true. `stop` asserts the
    // goal was met; `blocked` says the judge could not tell. A model that emits
    // both has told us it could not tell, and recording that as a completed
    // goal is the one wrong answer here that reads as success. Same reason the
    // status exists at all: the other two verdicts both assert an outcome.
    const blockedLine = candidates.find((entry) => /^blocked\b/i.test(entry));
    if (blockedLine) {
      const reason = blockedLine.replace(/^blocked\b[\s:.-]*/i, "").trim();
      return { decision: "blocked", reason: reason || undefined };
    }

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
  // stepInstruction drops the trailing "as $name": that half is Metis's
  // bookkeeping, and "draft the post as $draft" handed to a 7B is an
  // invitation to write the literal string "$draft" into the answer.
  const lines: string[] = [
    step ? (step.kind === "single" ? stepInstruction(step.text) : step.members.map(stepInstruction).join(" and ")) : loop.goal,
    ""
  ];
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
  const helpers = helpersForWakePrompt(loop.spawnedAgents ?? []);
  if (helpers.length) {
    lines.push("(Helpers you already asked for:");
    for (const agent of helpers) {
      const state = agent.status === "running" ? "still going" : agent.status;
      lines.push(`- ${agent.name} (${state})${agent.summary ? `: ${agent.summary}` : ""}`);
    }
    lines.push(")", "");
  }

  // The previous step's output, verbatim. Last before the protocol block and
  // farthest from the top on purpose: the step text has to stay the dominant
  // signal, and this is the longest thing in the prompt.
  //
  // Safe to include despite that: the tick routes on `routingPrompt` (the step
  // text alone), never on this string, so a draft full of code cannot turn
  // "review it" into a build. Only for a chain — a plain goal loop already
  // carries its own thread in one conversation and has nothing to hand across.
  // Earlier steps' output, oldest first. Only on a chain: a plain goal loop
  // keeps one conversation and already has its own thread to read.
  const artifacts = step ? artifactsForWakePrompt(loop) : [];
  if (artifacts.length) {
    lines.push(artifacts.length > 1 ? "(What earlier steps produced, oldest first, to work from:" : "(What the previous step produced, to work from:");
    for (const item of artifacts) {
      if (item.step) lines.push(`--- from "${item.step}" ---`);
      lines.push(item.text);
    }
    lines.push(")", "");
  }

  // Named outputs this step actually asks for, and only those
  // (docs/FLOWCHART_LOOPS_V2.md piece 1). Injecting every variable a chain has
  // ever declared would be the artifact channel again with extra steps — the
  // point of naming is that a step says which earlier output it means.
  if (step) {
    const members = step.kind === "single" ? [step.text] : step.members;
    const wanted: string[] = [];
    for (const member of members) {
      for (const name of stepVariableRefs(member)) if (!wanted.includes(name)) wanted.push(name);
    }
    const available = wanted.filter((name) => (loop.variables?.[name] ?? "").trim());
    if (available.length) {
      lines.push("(Named outputs this step refers to:");
      for (const name of available) {
        lines.push(`--- $${name} ---`);
        lines.push(captureArtifact(loop.variables?.[name] ?? "", LOOP_VARIABLE_LIMIT));
      }
      lines.push(")", "");
    }
  }

  // What the last turn's commands and checks actually PROVED. Sits below the
  // artifact and directly above the protocol block, so it is the last thing
  // read before the decision is asked for — the loop's own evidence should be
  // freshest when it chooses continue, stop or blocked.
  const evidence = loop.history[loop.history.length - 1]?.evidence ?? [];
  if (evidence.length) {
    lines.push("(What the last turn checked:");
    for (const item of evidence) {
      const code = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
      lines.push(`- ${item.label}: ${item.status}${code}${item.detail ? ` — ${item.detail}` : ""}`);
    }
    lines.push(")", "");
  }

  // WHY THIS TURN IS RUNNING, in the judge's own words. The last continue
  // carried a reason ("four functions still need comments") and until now that
  // string reached the panel and the tray and never the model, so every wake
  // re-derived the remaining work from a digest of what was already done. The
  // judge is the one thing in the loop that looked at the goal and the evidence
  // together; its sentence is the most specific instruction available and it
  // was being thrown away (docs/COMPETITIVE_SWEEP.md, shortlist item 2).
  //
  // Same neutral wording rule as the rest of this scaffolding, and placed
  // directly above the protocol block so it cannot outweigh the goal at the
  // top: routing classifies from prompt text, and a directive full of nouns
  // from the goal is exactly the kind of line that once turned a read into a
  // build.
  const lastContinue = loop.history[loop.history.length - 1];
  if (lastContinue?.decision === "continue" && lastContinue.reason) {
    lines.push(`(Why another turn was asked for: ${lastContinue.reason})`, "");
  }

  lines.push(loopDecisionPromptBlock());
  return lines.join("\n");
}

/** What a parallel instance is told about the others
 *  (docs/FLOWCHART_LOOPS_V2.md piece 2).
 *
 *  The debate literature is blunt that N identical reviewers performs about
 *  like one reviewer at N times the price, and until now `review x3` sent
 *  three helpers a byte-identical prompt with byte-identical context. This is
 *  the cheapest correction that does not require inventing subject matter.
 *
 *  It deliberately does NOT assign topics. Generic angles — "check
 *  correctness", "check clarity" — read well against a step called "review"
 *  and are nonsense against "research competitors", and a chain step is free
 *  text that Metis has no way to classify. Putting invented subject matter
 *  into somebody's step is the same failure as inventing a savings figure: it
 *  demos well and is silently wrong half the time.
 *
 *  What it says instead is only true things: how many of you there are, which
 *  one you are, and that a first-pass reading is already covered. That targets
 *  the measured failure (identical outputs) without pretending to know what
 *  the step is about. */
export function parallelInstanceBrief(index: number, total: number): string {
  return [
    `You are instance ${index} of ${total} working on this at the same time, independently.`,
    "The others are looking at exactly the same material, so the obvious first reading is already covered.",
    "Spend your turn on what a first pass would miss, and say plainly if you find nothing the others would not."
  ].join(" ");
}

/** How much of a named variable travels into a prompt. Same budget as one
 *  artifact, for the same reason: this IS an artifact, given a name. */
export const LOOP_VARIABLE_LIMIT = 3000;

/** Whether a decision the working model made about ITSELF needs a second
 *  opinion (docs/LOOPS.md, "the judge is not the worker").
 *
 *  Only a `continue` does. That is the asymmetry the whole feature runs on
 *  applied one level up: stopping is the recoverable direction, so a model
 *  saying "I am done" about its own work costs a wasted opportunity at worst,
 *  while "keep going, I am not finished" is the self-serving answer that spends
 *  money on every turn it buys. Verifying both would double the calls to
 *  re-check the answer that was already safe.
 *
 *  `blocked` is not verified either, for the same reason and a sharper one: it
 *  is the verdict that CLAIMS NOTHING, and a model that declines to assert an
 *  outcome has not graded itself favourably.
 *
 *  This exists because "the inline path is the low-stakes half" turned out to
 *  be wrong. Every wake prompt appends the decision block unconditionally, so
 *  any turn that routes to chat rather than the build pipeline answers inline —
 *  and that is every step of `plan -> draft -> review -> synthesise`, which is
 *  the shape flowchart chains are actually written in. Only file-writing turns
 *  reach the separate call. */
export function inlineDecisionNeedsSecondOpinion(decision: LoopDecision | null): boolean {
  return decision?.decision === "continue";
}

/** Whether the gate should be consulted after this turn.
 *
 *  Four ways to say no, and each is a different kind of "no": no gate was
 *  configured, this turn was not the gated step, the turn did not produce a
 *  verdict-able outcome, or the gate has already spent its attempts. Asking
 *  anyway would cost a model call whose answer is discarded. */
export function gateAppliesToTurn(loop: LoopRecord, positionIndex: number | null): boolean {
  if (!loop.gate || positionIndex === null) return false;
  if (loop.gate.at !== positionIndex) return false;
  return (loop.gateUsed ?? 0) < loop.gate.attempts;
}

/** Reads PASS or FAIL out of a gate reply, or null when it said neither.
 *
 *  **Null falls through**, which is the same governing rule the whole feature
 *  runs on: an unreadable answer degrades a gated chain to exactly the chain it
 *  would have been without the gate. A gate that guessed FAIL on silence would
 *  turn every flaky judge into an infinite retry, and one that guessed PASS
 *  would make a broken judge look like a working one.
 *
 *  FAIL wins a reply containing both, mirroring extractLoopDecision's
 *  ambiguity rule: going back is the recoverable direction — it costs a turn —
 *  while a wrong PASS ships the failure. */
export function extractGateVerdict(raw: string): "pass" | "fail" | null {
  const cleaned = (raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "");
  const candidates = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(pass|fail)\b/i.test(line))
    // The prompt lists both words, and a model that echoes the menu before
    // answering must not have its echo read as the answer.
    .filter((line) => !/<.*?>/.test(line));
  if (!candidates.length) return null;
  if (candidates.some((line) => /^fail\b/i.test(line))) return "fail";
  return "pass";
}

/** The prompt the gate judge is given.
 *
 *  It is told what the step was FOR and what actually ran, and nothing about
 *  the loop's protocol — this call has one job. Same one-job-per-call rule
 *  followups.ts learned the hard way and decideLoopContinuation inherited. */
export function gatePromptFor(input: { goal: string; step: string; produced: string; evidence?: LoopEvidence[] }): string {
  const evidenceLines: string[] = [];
  if (input.evidence?.length) {
    evidenceLines.push("WHAT ACTUALLY RAN, AND HOW IT ENDED:");
    for (const item of input.evidence) {
      const code = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
      evidenceLines.push(`- ${item.label}: ${item.status}${code}${item.detail ? ` — ${item.detail}` : ""}`);
    }
    evidenceLines.push("");
  }
  return [
    "One step of a background task just finished. Judge ONLY that step. You did not do this work.",
    "",
    "THE OVERALL GOAL:",
    input.goal,
    "",
    "THE STEP THAT JUST RAN:",
    stepInstruction(input.step),
    "",
    "WHAT IT PRODUCED:",
    input.produced || "(nothing was reported)",
    "",
    ...evidenceLines,
    "Answer with ONE word and nothing else:",
    "  PASS   if that step did its job well enough to build on",
    "  FAIL   if it needs redoing",
    "",
    "Judge the step, not the whole goal. Later steps have not run yet."
  ].join("\n");
}

/** Where the program counter goes after a turn on a chain.
 *
 *  Three writers now, and this is the only one that can go BACKWARDS. The ring
 *  is still the default — reaching the end starts again, because it is a loop —
 *  and a gate FAIL is the single exception (docs/FLOWCHART_LOOPS_V2.md).
 *
 *  Kept pure and separate from the tick because "which step runs next" is the
 *  one piece of loop state that a wrong answer makes unrecoverable: a counter
 *  that jumps to the wrong place does not error, it just quietly runs the wrong
 *  work forever. */
export function nextStepIndex(loop: LoopRecord, verdict: "pass" | "fail" | null): number | undefined {
  if (!loop.steps?.length) return loop.stepIndex;
  const current = loop.stepIndex ?? 0;
  if (verdict === "fail" && loop.gate && gateAppliesToTurn(loop, current % loop.steps.length)) {
    return loop.gate.target;
  }
  return (current + 1) % loop.steps.length;
}

/** What a loop turn is CALLED in the conversation it lands in
 *  (docs/ROADMAP.md, "a running loop is invisible in the chat it came from").
 *
 *  This is the string that stands where a user's message would be, so it has
 *  one job: say plainly that nobody typed this. "Loop turn 2 of 5 — fix what
 *  fails" is honest about all three things a reader needs — that this is a
 *  loop, how far through it is, and what it was asked to do this turn.
 *
 *  It is deliberately NOT the wake prompt. That is the goal plus a history
 *  digest plus the helper list plus the artifact plus a protocol block, and
 *  putting several hundred characters of Metis talking to itself into the chat
 *  attributed to the person is the whole failure being fixed.
 *
 *  Pure, so the offline suite can hold the wording still. */
export function loopTurnLabel(loop: LoopRecord, index: number): string {
  const step = currentLoopStep(loop);
  const what =
    step === null
      ? loop.goal
      : step.kind === "single"
        ? step.text
        : // A group position runs its members as parallel helpers rather than a
          // work turn, so the label names all of them.
          step.members.join(" and ");
  const oneLine = (what ?? "").replace(/\s+/g, " ").trim();
  const trimmed = oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
  const head = `Loop turn ${index} of ${loop.maxIterations}`;
  return trimmed ? `${head} — ${trimmed}` : head;
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

/** What a turn produced, kept whole enough for the next step to work ON it.
 *
 *  The only thing stripped is the metis-loop protocol block, which is Metis
 *  talking to itself and would otherwise invite the next step to answer a
 *  decision it was never asked for. Code fences survive: handing a reviewer
 *  the word "(code)" is the whole bug this exists to fix.
 *
 *  Truncation is head-and-tail rather than head-only. A draft's last lines are
 *  usually where it is weakest (an unclosed block, a trailing TODO, a stopped
 *  mid-sentence), so a reviewer that only ever sees the opening is blind to the
 *  most likely defect. */
export function captureArtifact(assistantText: string, limit = LOOP_ARTIFACT_LIMIT): string {
  const cleaned = (assistantText ?? "").replace(/```metis-loop[\s\S]*?```/g, "").trim();
  if (!cleaned) return "";
  if (cleaned.length <= limit) return cleaned;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${cleaned.slice(0, head).trimEnd()}\n\n[… ${cleaned.length - limit} characters trimmed from the middle …]\n\n${cleaned.slice(-tail).trimStart()}`;
}

/** The most recent turn output available to hand the step that runs next, or
 *  "" when there is nothing yet (turn one) or the last turns all errored. */
export function latestArtifact(loop: LoopRecord): string {
  for (let i = loop.history.length - 1; i >= 0; i -= 1) {
    const candidate = loop.history[i]?.artifact;
    if (candidate) return candidate;
  }
  return "";
}

/** How many earlier steps' outputs a turn can see, and the total they may
 *  occupy. Both bounds matter for different reasons: the count keeps the prompt
 *  readable, and the budget keeps a chain of long artifacts from growing its own
 *  prompt every cycle until --budget stops the loop. */
export const LOOP_ARTIFACT_HISTORY = 3;
export const LOOP_ARTIFACT_TOTAL_BUDGET = 6000;

/** The earlier steps' outputs a turn should be able to work from.
 *
 *  One hop was wrong for the shape chains are actually written in. A
 *  `plan -> draft -> review -> synthesise` chain has a final step whose whole
 *  job is to combine things, and it could only see the review — not the draft
 *  being reviewed. Two steps that both produced work handed only the later one
 *  forward, so the earlier was silently discarded.
 *
 *  Newest-first while selecting, because the most recent output is the most
 *  likely to matter and should survive the budget; oldest-first when returned,
 *  because a synthesise step reading them chronologically is reading the story
 *  in order.
 *
 *  Labelled by the step that produced each one. Without labels a synthesise
 *  step gets three unattributed blobs and has to guess which is the draft and
 *  which is the critique, which is exactly the guessing this exists to stop. */
export function artifactsForWakePrompt(
  loop: LoopRecord,
  maxCount = LOOP_ARTIFACT_HISTORY,
  maxTotal = LOOP_ARTIFACT_TOTAL_BUDGET
): Array<{ step?: string; text: string }> {
  const picked: Array<{ step?: string; text: string }> = [];
  let spent = 0;
  for (let i = loop.history.length - 1; i >= 0 && picked.length < maxCount; i -= 1) {
    const entry = loop.history[i];
    const text = entry?.artifact;
    if (!text) continue;
    // A partial artifact would be a lie about what the earlier step produced,
    // so an over-budget one is skipped whole rather than truncated. Keep
    // scanning: an older, shorter artifact may still fit.
    if (spent + text.length > maxTotal) continue;
    spent += text.length;
    picked.push({ step: entry.step, text });
  }
  return picked.reverse();
}

/** Which helpers a wake prompt should show.
 *
 *  Not simply the last N. Helpers arrive from two places — a decision block's
 *  `spawn`, and the members of a parallel step group — and on the second pass
 *  through a chain the flat tail mixes this cycle's group with the last one's,
 *  with nothing in the rendered line to tell them apart. So: every member of
 *  the NEWEST group is kept whole (a synthesise step that silently loses a
 *  reviewer to a six-entry window is worse than one that shows none), older
 *  groups are dropped entirely, and ungrouped helpers fill the remaining room
 *  newest-first. */
export function helpersForWakePrompt(agents: LoopSpawnedAgent[], limit = 6): LoopSpawnedAgent[] {
  if (!agents.length) return [];
  const newestGroup = agents.reduce<string | undefined>(
    (best, agent) => (agent.groupStartedAt && (!best || agent.groupStartedAt > best) ? agent.groupStartedAt : best),
    undefined
  );
  const current = newestGroup ? agents.filter((agent) => agent.groupStartedAt === newestGroup) : [];
  const room = Math.max(0, limit - current.length);
  const ungrouped = agents.filter((agent) => !agent.groupStartedAt).slice(-room);
  return [...ungrouped, ...current];
}
