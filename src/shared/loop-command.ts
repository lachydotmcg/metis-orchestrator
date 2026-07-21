/**
 * The "/loop" composer command.
 *
 * Lives in shared/ on purpose. The only other slash command, "/orchestration",
 * is parsed by its own regex in main.ts AND mirrored by a second, independent
 * regex in App.tsx, with a comment on each side saying it mirrors the other.
 * Two copies of a grammar drift the moment one side gains a flag. This module
 * is the single source both sides import, so the hint the user reads while
 * typing is produced by the same parser that will actually run the command.
 *
 * Grammar:
 *   /loop <goal>
 *   /loop --turns 5 <goal>
 *   /loop --every 15m <goal>
 *   /loop --turns 5 --every 15m <goal>
 *
 * Flags rather than positional arguments, deliberately: "/loop 15m 5 count to
 * nine" cannot be told apart from a goal that happens to start with a number,
 * and the whole point of this command is that the composer can explain each
 * part as you type it. A named flag explains itself.
 */

/** The floor matches LOOP_MIN_DELAY_SECONDS in electron/loops.ts: a sub-minute
 *  gap is a hot loop of real inference calls whoever asked for it. */
export const LOOP_COMMAND_MIN_INTERVAL_SECONDS = 60;

/** The ceiling deliberately does NOT match the model's LOOP_MAX_DELAY_SECONDS
 *  (1 hour). That clamp exists to stop a CONFUSED MODEL parking a loop past the
 *  horizon where its owner has forgotten it exists. A person typing
 *  "--every 2h" is not confused, they are describing a schedule they want, and
 *  refusing it would make the flag useless for the thing people most obviously
 *  want it for.
 *
 *  6 hours rather than unlimited, because LOOP_MAX_AGE_HOURS retires a loop
 *  after 12: capping the interval at half the lifetime guarantees any loop a
 *  user schedules gets at least two turns before it expires, instead of dying
 *  having run once and looking broken. */
export const LOOP_COMMAND_MAX_INTERVAL_SECONDS = 6 * 3600;
export const LOOP_COMMAND_MAX_TURNS = 25;
export const LOOP_COMMAND_DEFAULT_TURNS = 8;

/** Floor on "--budget". Not protection of the user's money — that is the whole
 *  point of the flag — protection against a typo'd "--budget 2" creating a
 *  loop whose first turn always exhausts it, which reads as broken rather
 *  than as the clamp doing its job. One real turn of a small local model runs
 *  a few thousand tokens; 1000 is the smallest budget that can mean anything. */
export const LOOP_COMMAND_MIN_BUDGET_TOKENS = 1000;

export interface LoopCommandParts {
  /** The goal, with the command token and every flag stripped out. */
  goal: string;
  /** Iteration cap. Undefined means "use the default". */
  turns?: number;
  /** When set, every wake uses this fixed delay instead of the one the model
   *  asks for. Undefined means the model chooses, which is the default because
   *  a self-paced loop is the thing that makes this different from a cron job. */
  everySeconds?: number;
  /** Token ceiling (input + output, summed from the usage ledger). The loop
   *  settles as `exhausted` once its attributed spend reaches this. Undefined
   *  means no token ceiling — the iteration cap and wall-clock limit still
   *  apply, so "no budget" never means "unbounded". */
  budgetTokens?: number;
}

export interface LoopCommandParse {
  /** False when the text is not a /loop command at all. */
  isLoopCommand: boolean;
  parts?: LoopCommandParts;
  /** Present when the text IS a /loop command but cannot run as written. The
   *  composer shows this instead of a ready-to-send hint, so a typo is caught
   *  before a key is pressed rather than after a run is attempted. */
  error?: string;
}

const LOOP_COMMAND_RE = /^\s*\/loop\b\s*(.*)$/is;

/** Accepts 90s, 15m, 2h, or a bare number read as minutes (the unit people mean
 *  when they say "every 15"). Returns null for anything it cannot read, which
 *  the caller turns into a visible error rather than a silent default. */
export function parseLoopDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] ?? "m";
  const seconds = unit.startsWith("s") ? value : unit.startsWith("h") ? value * 3600 : value * 60;
  return Math.round(seconds);
}

export function formatLoopDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Accepts 50000, 200k, or 1.5m — the units people actually use for token
 *  counts. Returns null for anything it cannot read, same contract as
 *  parseLoopDuration: the caller shows an error instead of guessing. */
export function parseTokenCount(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/,/g, "");
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(k|m)?(?:\s*tok(?:ens?)?)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1000 : 1;
  return Math.round(value * multiplier);
}

/** 200000 → "200k", 1500000 → "1.5m", 4321 → "4321". Round numbers only get
 *  the short form; anything else is printed exactly, because a budget display
 *  that rounds is a budget display that lies. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}m`;
  if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k`;
  return String(tokens);
}

/** Never throws. Anything malformed comes back as an `error` string written for
 *  a human to read in the composer, not a stack trace. */
export function parseLoopCommand(text: string): LoopCommandParse {
  const match = typeof text === "string" ? text.match(LOOP_COMMAND_RE) : null;
  if (!match) return { isLoopCommand: false };

  const rest = (match[1] ?? "").trim();
  const parts: LoopCommandParts = { goal: "" };
  const goalWords: string[] = [];
  const tokens = rest.split(/\s+/).filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();

    if (lower === "--turns" || lower === "--iterations" || lower === "-n") {
      const value = tokens[index + 1];
      if (value === undefined) return { isLoopCommand: true, error: "--turns needs a number, like --turns 5." };
      const turns = Number(value);
      if (!Number.isInteger(turns) || turns < 1) {
        return { isLoopCommand: true, error: `--turns needs a whole number of 1 or more, got "${value}".` };
      }
      if (turns > LOOP_COMMAND_MAX_TURNS) {
        return { isLoopCommand: true, error: `--turns is capped at ${LOOP_COMMAND_MAX_TURNS}. A loop that needs more than that has usually misunderstood its goal.` };
      }
      parts.turns = turns;
      index += 1;
      continue;
    }

    if (lower === "--every" || lower === "--interval") {
      const value = tokens[index + 1];
      if (value === undefined) return { isLoopCommand: true, error: "--every needs a duration, like --every 15m." };
      const seconds = parseLoopDuration(value);
      if (seconds === null) {
        return { isLoopCommand: true, error: `--every could not read "${value}". Try 90s, 15m or 2h.` };
      }
      if (seconds < LOOP_COMMAND_MIN_INTERVAL_SECONDS || seconds > LOOP_COMMAND_MAX_INTERVAL_SECONDS) {
        return {
          isLoopCommand: true,
          error: `--every must be between ${formatLoopDuration(LOOP_COMMAND_MIN_INTERVAL_SECONDS)} and ${formatLoopDuration(LOOP_COMMAND_MAX_INTERVAL_SECONDS)}, got ${formatLoopDuration(seconds)}.`
        };
      }
      parts.everySeconds = seconds;
      index += 1;
      continue;
    }

    if (lower === "--budget" || lower === "--tokens") {
      const value = tokens[index + 1];
      if (value === undefined) return { isLoopCommand: true, error: "--budget needs a token count, like --budget 200k." };
      const budget = parseTokenCount(value);
      if (budget === null) {
        return { isLoopCommand: true, error: `--budget could not read "${value}". Try 50000, 200k or 1.5m.` };
      }
      if (budget < LOOP_COMMAND_MIN_BUDGET_TOKENS) {
        return {
          isLoopCommand: true,
          error: `--budget must be at least ${formatTokenCount(LOOP_COMMAND_MIN_BUDGET_TOKENS)} tokens — anything smaller exhausts on the first turn.`
        };
      }
      parts.budgetTokens = budget;
      index += 1;
      continue;
    }

    // An unrecognised --flag is an error rather than goal text. Swallowing it
    // into the goal would mean a typo like "--turn 5" silently becomes part of
    // what the model is asked to do, and the loop runs with the default cap.
    if (lower.startsWith("--")) {
      return { isLoopCommand: true, error: `I do not know the flag "${token}". Supported: --turns, --every, --budget.` };
    }

    goalWords.push(token);
  }

  parts.goal = goalWords.join(" ").trim();
  return { isLoopCommand: true, parts };
}

export interface LoopCommandHintSegment {
  /** What the user typed, or the label for a default they did not type. */
  label: string;
  /** Plain-English meaning, shown next to the label. */
  meaning: string;
  /** True when this reflects text actually present, false for an applied default. */
  typed: boolean;
}

/** Builds the live explanation shown under the composer. Every segment is
 *  described in the same terms whether the user typed it or it is a default, so
 *  the hint teaches the grammar by showing what the command WILL do rather than
 *  listing flags nobody reads. */
export function describeLoopCommand(parse: LoopCommandParse): LoopCommandHintSegment[] {
  if (!parse.isLoopCommand || parse.error) return [];
  const parts = parse.parts;
  if (!parts) return [];

  const segments: LoopCommandHintSegment[] = [];

  segments.push(
    parts.goal
      ? { label: truncate(parts.goal, 52), meaning: "the goal it works on", typed: true }
      : { label: "no goal yet", meaning: "type what you want it to work on", typed: false }
  );

  segments.push(
    parts.turns !== undefined
      ? { label: `${parts.turns} turns`, meaning: "hard stop after this many", typed: true }
      : { label: `${LOOP_COMMAND_DEFAULT_TURNS} turns`, meaning: "default cap, set with --turns", typed: false }
  );

  segments.push(
    parts.everySeconds !== undefined
      ? { label: `every ${formatLoopDuration(parts.everySeconds)}`, meaning: "fixed gap between turns", typed: true }
      : { label: "self-paced", meaning: "it picks its own gap, set with --every", typed: false }
  );

  segments.push(
    parts.budgetTokens !== undefined
      ? { label: `${formatTokenCount(parts.budgetTokens)} tokens`, meaning: "spend ceiling, then it stops", typed: true }
      : { label: "no token budget", meaning: "cap spend with --budget", typed: false }
  );

  return segments;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
