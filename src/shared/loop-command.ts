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
  /** Flowchart loop (docs/FLOWCHART_LOOPS_DESIGN.md): an ordered step chain
   *  from '--steps "read -> plan -> research & review -> implement"'. Each
   *  position is either one step (string) or a parallel GROUP (string[]) —
   *  "&" binds tighter than "->", and a group's members run as phase 2A
   *  helpers side by side before the chain moves on. Parenthesised
   *  multi-step branches are still refused: a branch that is itself a chain
   *  needs per-branch program counters that do not exist yet. The loop back
   *  to the start is implicit. */
  steps?: LoopStepPosition[];
  /** '--gate "synthesise fails -> draft" --gate-attempts 3'
   *  (docs/FLOWCHART_LOOPS_V2.md piece 1). One conditional edge: after the named
   *  step runs, a model that did NOT do the work is asked PASS or FAIL, and a
   *  FAIL sends the chain back to the target instead of forward.
   *
   *  Absent on every chain that does not ask for one, and a chain with a gate
   *  behaves exactly like one without it whenever the verdict is unreadable —
   *  silence falls through, same governing rule as everything else here. */
  gate?: LoopGate;
  /** "--flowchart" (docs/FLOWCHART_LOOPS_DESIGN.md): ask a model to PROPOSE
   *  a step chain for the goal. The proposal comes back as the same string
   *  the user would have typed — inserted into the composer for review and
   *  editing, never run directly. Mutually exclusive with --steps. */
  flowchart?: boolean;
}

/** One position in a step chain: a single step, or a parallel group. */
export type LoopStepPosition = string | string[];

/** A conditional edge (docs/FLOWCHART_LOOPS_V2.md piece 1) — the "Pass?" diamond
 *  from the reference flowchart, and the first thing in this grammar that
 *  decides WHERE rather than only WHETHER.
 *
 *  Positions, not names. Resolved once at parse time so the tick never
 *  re-searches the chain and an edited chain cannot silently repoint an edge at
 *  whatever step happens to sit at that text now. */
export interface LoopGate {
  /** The position whose output is judged. */
  at: number;
  /** Where a FAIL jumps to. May equal `at`, which means "try that step again". */
  target: number;
  /** How many times the gate may send the chain backwards before it gives up
   *  and lets the chain proceed. A gate with no ceiling is an infinite loop
   *  wearing a condition. */
  attempts: number;
}

/** Ceiling on --gate-attempts. Three is the doc's number and five is as far as
 *  it can be pushed: "LLMs Cannot Self-Correct Reasoning Yet" is the reason the
 *  gate exists at all, and it is also the reason a tenth retry is not going to
 *  be the one that works. */
export const LOOP_COMMAND_MAX_GATE_ATTEMPTS = 5;
export const LOOP_COMMAND_DEFAULT_GATE_ATTEMPTS = 3;

/** Matches a step's trailing "as $name" declaration.
 *
 *  The start anchor matters: a step written as bare "as $draft" is a mistake
 *  worth catching, and without it the declaration goes unrecognised and the
 *  words "as $draft" get sent to a model as if they were the instruction. */
const STEP_VARIABLE_DECLARATION = /(?:^|\s)as\s+\$([a-z][a-z0-9_]*)\s*$/i;

/** Every "$name" reference in a step. */
const STEP_VARIABLE_REFERENCE = /\$([a-z][a-z0-9_]*)/gi;

/** The name a step declares with a trailing "as $name", or null.
 *
 *  Naming makes explicit what the artifact channel already carries positionally:
 *  today a step sees the last three outputs labelled by the step that made them,
 *  so it can say "whatever came before" but never "the draft". */
export function stepVariableName(step: string): string | null {
  const match = STEP_VARIABLE_DECLARATION.exec(step ?? "");
  return match ? match[1].toLowerCase() : null;
}

/** The step text with its "as $name" removed — what the MODEL is actually told
 *  to do.
 *
 *  Stripping it is not tidiness. "draft the post as $draft" handed to a 7B is an
 *  invitation to write the literal string "$draft" into the output, and the
 *  declaration is Metis's bookkeeping rather than part of the instruction. */
export function stepInstruction(step: string): string {
  return (step ?? "").replace(STEP_VARIABLE_DECLARATION, "").trim();
}

/** Every variable a step REFERENCES, lowercased and deduplicated. A step's own
 *  trailing declaration is not a reference to itself. */
export function stepVariableRefs(step: string): string[] {
  const instruction = stepInstruction(step);
  const found = new Set<string>();
  for (const match of instruction.matchAll(STEP_VARIABLE_REFERENCE)) found.add(match[1].toLowerCase());
  return [...found];
}

/** Extracts the chain line out of a model's chain-drafting reply: think
 *  blocks dropped, the LAST non-empty line taken (models preamble before
 *  their answer), surrounding quotes stripped. Validation happens in
 *  parseStepChain afterwards — this only isolates the candidate line. */
export function cleanDraftedChain(raw: string): string {
  const lines = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.length ? lines[lines.length - 1] : "";
  return line.replace(/^["'`]+|["'`]+$/g, "").trim();
}

/** Step-count ceiling for "--steps", counted over every step INCLUDING group
 *  members. The chain is replayed into every wake prompt, so a long cycle
 *  costs tokens on every turn forever — the design doc calls for a hard cap
 *  rather than good intentions. */
export const LOOP_COMMAND_MAX_STEPS = 8;

/** A parallel group's size ceiling. Mirrors LOOP_MAX_SPAWN_PER_TURN in
 *  electron/loops.ts: each group member becomes one helper, and one turn may
 *  not ask for more helpers than that. */
export const LOOP_COMMAND_MAX_GROUP = 3;

/** Parses a step chain: "read -> plan -> research & review -> implement".
 *  "&" binds tighter than "->" and produces a parallel group at that
 *  position. Parentheses (multi-step branches) are recognised and refused
 *  with a message that says the feature is coming, not that the user typed
 *  it wrong. Returns an error string (for the composer to show) or the
 *  position list. */
export function parseStepChain(raw: string): { steps?: LoopStepPosition[]; error?: string } {
  const text = raw.trim();
  if (!text) return { error: '--steps needs a chain, like --steps "read -> plan -> implement".' };
  if (/[()]/.test(text)) {
    return { error: "Parenthesised multi-step branches are designed but not runnable yet — a branch that is itself a chain needs its own program counter. Single steps joined with \"&\" DO run in parallel." };
  }
  const positions: LoopStepPosition[] = [];
  let flatCount = 0;
  for (const rawPosition of text.split("->")) {
    const members = rawPosition.split("&").map((step) => step.replace(/\s+/g, " ").trim());
    if (members.some((step) => !step)) {
      return { error: 'The chain has an empty step — check for a doubled or trailing "->" or "&".' };
    }
    if (members.length > LOOP_COMMAND_MAX_GROUP) {
      return { error: `A parallel group is capped at ${LOOP_COMMAND_MAX_GROUP} steps — each one runs as its own helper, and one turn may not start more than that.` };
    }
    const tooLong = members.find((step) => step.length > 80);
    if (tooLong) {
      return { error: `Step "${tooLong.slice(0, 40)}…" is over 80 characters — steps are instructions, not paragraphs.` };
    }
    flatCount += members.length;
    positions.push(members.length === 1 ? members[0] : members);
  }
  if (positions.length < 2) {
    return { error: "A chain needs at least two positions. For a single goal, plain /loop already does this." };
  }
  if (flatCount > LOOP_COMMAND_MAX_STEPS) {
    return { error: `The chain is capped at ${LOOP_COMMAND_MAX_STEPS} steps in total — it is replayed every turn, so every extra step costs tokens forever.` };
  }
  // Variables, checked here so a typo is caught in the composer rather than
  // becoming a literal "$draf" in a prompt that then quietly does nothing. A
  // reference must be to a name an EARLIER position declared: the chain is a
  // ring, so a later declaration would work on the second pass and not the
  // first, which is the worst kind of intermittent.
  const declared = new Set<string>();
  for (let position = 0; position < positions.length; position += 1) {
    const members = Array.isArray(positions[position]) ? (positions[position] as string[]) : [positions[position] as string];
    for (const member of members) {
      for (const reference of stepVariableRefs(member)) {
        if (!declared.has(reference)) {
          return {
            error: `"$${reference}" is used before anything names it. Add "as $${reference}" to an earlier step, like "draft as $${reference}".`
          };
        }
      }
    }
    // Declarations land AFTER the whole position is checked, so a group member
    // cannot reference a name its own sibling declares — they run side by side
    // and neither can see the other's output.
    for (const member of members) {
      const name = stepVariableName(member);
      if (name) {
        if (declared.has(name)) {
          return { error: `"$${name}" is named twice. Each name belongs to one step, or a reference cannot say which output it means.` };
        }
        if (!stepInstruction(member)) {
          return { error: `A step that is only "as $${name}" has nothing to do. Put the instruction first, like "draft the post as $${name}".` };
        }
        declared.add(name);
      }
    }
  }
  return { steps: positions };
}

/** Parses '--gate "synthesise fails -> draft"' against an already-parsed chain.
 *
 *  Both sides are matched against the chain by text, then stored as POSITIONS.
 *  A name that matches nothing is an error rather than a no-op: a gate that
 *  silently never fires is indistinguishable from a chain with no gate, and the
 *  user would be waiting for a branch that can never happen. */
export function parseGateSpec(raw: string, steps: LoopStepPosition[]): { gate?: Omit<LoopGate, "attempts">; error?: string } {
  const text = (raw ?? "").trim();
  if (!text) return { error: '--gate needs a rule, like --gate "synthesise fails -> draft".' };
  const match = /^(.+?)\s+fails\s*->\s*(.+)$/i.exec(text);
  if (!match) {
    return { error: `--gate reads "<step> fails -> <step>", like --gate "synthesise fails -> draft". Got "${text.slice(0, 40)}".` };
  }
  const findPosition = (needle: string): number => {
    const wanted = needle.replace(/\s+/g, " ").trim().toLowerCase();
    return steps.findIndex((position) => {
      const members = Array.isArray(position) ? position : [position];
      return members.some((member) => stepInstruction(member).toLowerCase() === wanted || member.replace(/\s+/g, " ").trim().toLowerCase() === wanted);
    });
  };
  const at = findPosition(match[1]);
  if (at < 0) return unknownStepError(match[1], steps);
  const target = findPosition(match[2]);
  if (target < 0) return unknownStepError(match[2], steps);
  // A group position runs its members as parallel helpers and returns before
  // any work turn, so there is no single output to judge and nothing for a
  // verdict to be about.
  if (Array.isArray(steps[at])) {
    return { error: `--gate cannot judge "${match[1].trim()}" — it is a parallel group, and a group has no single output to pass or fail.` };
  }
  return { gate: { at, target } };
}

function unknownStepError(needle: string, steps: LoopStepPosition[]): { error: string } {
  return {
    error: `--gate names "${needle.replace(/\s+/g, " ").trim().slice(0, 40)}", which is not a step in this chain. The steps are: ${formatStepChain(steps)}.`
  };
}

/** "read -> a & b -> done" — the one true rendering of a chain, used by the
 *  hint, the panel and the record label so no surface invents its own. */
export function formatStepChain(steps: LoopStepPosition[]): string {
  return steps.map((position) => (Array.isArray(position) ? position.join(" & ") : position)).join(" -> ");
}

/** Total step count including group members, for caps and labels. */
export function countChainSteps(steps: LoopStepPosition[]): number {
  return steps.reduce<number>((sum, position) => sum + (Array.isArray(position) ? position.length : 1), 0);
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
  let gateSpec: string | undefined;
  let gateAttempts: number | undefined;

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

    if (lower === "--flowchart") {
      parts.flowchart = true;
      continue;
    }

    if (lower === "--steps") {
      const quoted = readQuotedValue(tokens, index + 1);
      if (!quoted) {
        return {
          isLoopCommand: true,
          error: tokens[index + 1] === undefined ? '--steps needs a chain, like --steps "read -> plan -> implement".' : "--steps has an unclosed quote."
        };
      }
      const parsedChain = parseStepChain(quoted.value);
      if (parsedChain.error) return { isLoopCommand: true, error: parsedChain.error };
      parts.steps = parsedChain.steps;
      index += quoted.consumed;
      continue;
    }

    if (lower === "--gate") {
      const quoted = readQuotedValue(tokens, index + 1);
      if (!quoted) return { isLoopCommand: true, error: '--gate needs a rule, like --gate "synthesise fails -> draft".' };
      // Held as text and resolved after the whole command is read: --gate can
      // be typed before --steps, and it can only be validated against a chain
      // that has already been parsed.
      gateSpec = quoted.value;
      index += quoted.consumed;
      continue;
    }

    if (lower === "--gate-attempts") {
      const value = tokens[index + 1];
      if (value === undefined) return { isLoopCommand: true, error: "--gate-attempts needs a number, like --gate-attempts 3." };
      const attempts = Number(value);
      if (!Number.isInteger(attempts) || attempts < 1) {
        return { isLoopCommand: true, error: `--gate-attempts needs a whole number of 1 or more, got "${value}".` };
      }
      if (attempts > LOOP_COMMAND_MAX_GATE_ATTEMPTS) {
        return {
          isLoopCommand: true,
          error: `--gate-attempts is capped at ${LOOP_COMMAND_MAX_GATE_ATTEMPTS}. A step that has failed that many times is not going to pass on the next try.`
        };
      }
      gateAttempts = attempts;
      index += 1;
      continue;
    }

    // An unrecognised --flag is an error rather than goal text. Swallowing it
    // into the goal would mean a typo like "--turn 5" silently becomes part of
    // what the model is asked to do, and the loop runs with the default cap.
    if (lower.startsWith("--")) {
      return { isLoopCommand: true, error: `I do not know the flag "${token}". Supported: --turns, --every, --budget, --steps, --gate, --gate-attempts.` };
    }

    goalWords.push(token);
  }

  parts.goal = goalWords.join(" ").trim();
  if (parts.flowchart && parts.steps) {
    return { isLoopCommand: true, error: "--flowchart asks a model to draft the chain; --steps supplies one. Pick one." };
  }
  if (parts.flowchart && !parts.goal) {
    return { isLoopCommand: true, error: "--flowchart needs a goal to draft a chain for, like /loop --flowchart tidy the docs." };
  }
  // The gate resolves LAST, because it names steps and flags may be typed in
  // any order — "--gate ... --steps ..." has to work as well as the reverse.
  if (gateSpec !== undefined) {
    if (!parts.steps) {
      return { isLoopCommand: true, error: "--gate needs a chain to name steps in. Add --steps, or drop the gate." };
    }
    const parsedGate = parseGateSpec(gateSpec, parts.steps);
    if (parsedGate.error || !parsedGate.gate) return { isLoopCommand: true, error: parsedGate.error };
    parts.gate = { ...parsedGate.gate, attempts: gateAttempts ?? LOOP_COMMAND_DEFAULT_GATE_ATTEMPTS };
  } else if (gateAttempts !== undefined) {
    // A ceiling on a gate that does not exist reads as configured and does
    // nothing, which is exactly the shape of bug this grammar keeps refusing.
    return { isLoopCommand: true, error: "--gate-attempts only means something with --gate. Add the rule, like --gate \"synthesise fails -> draft\"." };
  }
  return { isLoopCommand: true, parts };
}

/** Reads a possibly-quoted flag value out of whitespace-split tokens.
 *
 *  The composer hands this parser a flat token list, so a quoted value arrives
 *  in pieces and has to be rejoined up to its closing quote. Shared by --steps
 *  and --gate because both take a phrase, and two copies of quote handling is
 *  two places for an unclosed quote to behave differently. */
function readQuotedValue(tokens: string[], start: number): { value: string; consumed: number } | null {
  const first = tokens[start];
  if (first === undefined) return null;
  const quote = first.startsWith('"') ? '"' : first.startsWith("'") ? "'" : null;
  if (!quote) return { value: first, consumed: 1 };
  let value = first;
  let consumed = 1;
  while (!(value.length > 1 && value.endsWith(quote))) {
    const next = tokens[start + consumed];
    if (next === undefined) return null;
    value += ` ${next}`;
    consumed += 1;
  }
  return { value: value.slice(1, -1), consumed };
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
      : parts.steps
        ? { label: "chain-driven", meaning: "the step cycle below is the goal", typed: false }
        : { label: "no goal yet", meaning: "type what you want it to work on", typed: false }
  );

  if (parts.steps) {
    segments.push({
      label: `${countChainSteps(parts.steps)}-step cycle`,
      meaning: truncate(formatStepChain(parts.steps), 60),
      typed: true
    });
  }

  if (parts.gate && parts.steps) {
    const nameAt = (position: number): string => {
      const entry = parts.steps?.[position];
      const text = Array.isArray(entry) ? entry.join(" & ") : (entry ?? "");
      return truncate(stepInstruction(text), 24);
    };
    segments.push({
      label: `gate on "${nameAt(parts.gate.at)}"`,
      meaning: `a fail sends it back to "${nameAt(parts.gate.target)}", up to ${parts.gate.attempts} time${parts.gate.attempts === 1 ? "" : "s"}`,
      typed: true
    });
  }

  if (parts.flowchart) {
    segments.push({
      label: "AI-drafted chain",
      meaning: "a model proposes the steps; you review before anything runs",
      typed: true
    });
  }

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
