/** The loop walkthrough: what a finished unattended run actually did, written
 *  into the folder it worked in.
 *
 *  The premise (docs/COMPETITIVE_SWEEP.md, shortlist item 1) is that an agent
 *  which worked for two hours while nobody watched owes the owner a readable
 *  account, and every competitor that writes one has to RECONSTRUCT it from its
 *  own tool calls afterwards. Metis does not: the routing decision, the depth
 *  judged, the model that served each turn and the token counts are typed
 *  records the moment they happen.
 *
 *  Which is why the routing trace goes FIRST, above the files and the verdict.
 *  Every agent can tell you what it wrote. The line no competitor can print is
 *  "turn 3 was judged deep, so it went to Opus 5, and turn 4 was trivial, so it
 *  went to a local 8B and cost nothing" — that is the product's whole argument,
 *  stated in evidence rather than in marketing.
 *
 *  Pure and string-in/string-out on purpose: main owns the file write, this owns
 *  the words, and the offline suite exercises the real formatter rather than a
 *  copy of it.
 */

import { costLabel } from "./model-catalogue.js";

/** What served one turn, captured at the tick rather than reconstructed. */
export interface WalkthroughRouting {
  provider?: string;
  model?: string;
  /** The judged difficulty, 1 trivial to 3 deep. Absent when Depths was off or
   *  the run was pinned — which is itself worth printing, because "not judged"
   *  and "judged trivial" are different facts about a run. */
  depth?: 1 | 2 | 3;
  /** The rung this turn started on before a blown thinking budget promoted it
   *  (shared/think-budget.ts). The one row in this table where the router
   *  admits it was wrong, so it is printed rather than smoothed over. */
  promotedFrom?: 1 | 2 | 3;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
  durationMs?: number;
}

/** One file a turn wrote. */
export interface WalkthroughFile {
  path: string;
  kind: "create" | "edit";
  addedLines?: number;
  removedLines?: number;
}

export interface WalkthroughTurn {
  index: number;
  at: string;
  step?: string;
  decision: "continue" | "stop" | "silent" | "blocked";
  reason?: string;
  error?: string;
  summary?: string;
  /** Who answered the continue-or-stop question, when it was asked as a
   *  separate call. Printed because "a different model checked this" is a
   *  claim, and a claim in a report that cannot be traced to a name is
   *  decoration. `independent` is a stored fact rather than something inferred
   *  from the name here — only the caller knows whether that model is also the
   *  one that did the work. */
  judgedBy?: { model: string; independent: boolean; note?: string };
  routing?: WalkthroughRouting;
  files?: WalkthroughFile[];
  /** The backup taken before this turn's writes. Present only on a turn that
   *  wrote through the generated-file path, which is the only writer that
   *  snapshots. */
  snapshot?: { id: string; dir: string };
  evidence?: { label: string; status: "complete" | "warning" | "error"; exitCode?: number; detail?: string }[];
}

export interface WalkthroughInput {
  loopId: string;
  goal: string;
  status: string;
  stoppedReason?: string;
  createdAt: string;
  finishedAt: string;
  projectPath?: string;
  /** The formatted step chain, for a flowchart loop. */
  chain?: string;
  budgetTokens?: number;
  history: WalkthroughTurn[];
  /** Helpers the loop launched. Only their names and outcomes: a helper runs
   *  in its own conversation and is not a turn of this loop, so it has no row
   *  in the routing table — and the table's total therefore UNDERSTATES what
   *  the loop spent whenever helpers ran. That gap is stated in the file
   *  rather than papered over, because `--budget` counts helper spend and a
   *  reader comparing the two numbers deserves to know why they differ. */
  helpers?: { name: string; status: string; task?: string }[];
  /** `provider::model` -> $/Mtok, assembled by the caller from the catalogue.
   *  Passed in rather than looked up so this file stays pure and so a run whose
   *  model has since left the catalogue still formats. */
  pricing?: Record<string, { in: number; out: number }>;
}

/** The first line of every walkthrough Metis writes. Used to recognise its own
 *  output before overwriting a file — see walkthroughFileName. */
export const WALKTHROUGH_MARKER = "<!-- metis:walkthrough";

const DEPTH_WORDS: Record<number, string> = { 1: "trivial", 2: "standard", 3: "deep" };

const DASH = "—";

/** Markdown table cells cannot contain a raw pipe, and a model name or a goal
 *  can. Escaping beats stripping: the reader still sees the character. */
function cell(text: string | undefined): string {
  const value = (text ?? "").replace(/\r?\n/g, " ").trim();
  return value ? value.replace(/\|/g, "\\|") : DASH;
}

function tokens(count: number | undefined, estimated?: boolean): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return DASH;
  return `${estimated ? "~" : ""}${Math.round(count).toLocaleString("en-US")}`;
}

function seconds(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DASH;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** "deep (L3)" or, when Depths was off, "not judged" — never a blank, because a
 *  blank in the difficulty column reads as though the judge said nothing when
 *  in fact it was never asked. */
function depthLabel(depth: number | undefined, promotedFrom?: number): string {
  if (depth === undefined) return "not judged";
  const now = `${DEPTH_WORDS[depth] ?? "unknown"} (L${depth})`;
  // A promoted turn reports BOTH rungs. Printing only the one that answered
  // would hide the only moment routing ever discovers it guessed wrong, which
  // is the most interesting line the table can carry.
  if (promotedFrom === undefined || promotedFrom === depth) return now;
  return `${DEPTH_WORDS[promotedFrom] ?? "unknown"} → ${now}, promoted`;
}

/** Cost for one turn, using the caller's pricing table and the same rules the
 *  Usage tab renders with. Unknown stays unknown. */
function turnCost(routing: WalkthroughRouting | undefined, pricing: WalkthroughInput["pricing"]): string {
  if (!routing?.provider) return DASH;
  const found = pricing?.[`${routing.provider}::${routing.model ?? ""}`] ?? null;
  return costLabel(found, {
    provider: routing.provider,
    inputTokens: routing.inputTokens ?? 0,
    outputTokens: routing.outputTokens ?? 0,
    estimated: routing.estimated
  });
}

function elapsed(from: string, to: string): string {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return DASH;
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** How the verdict reads at the top of the file. Deliberately not a single
 *  "done/not done": `blocked` exists precisely so a loop can decline to claim
 *  an outcome, and flattening it back into stopped would undo that. */
function verdictLine(input: WalkthroughInput): string {
  const reason = input.stoppedReason?.trim();
  const suffix = reason ? ` ${reason}` : "";
  switch (input.status) {
    case "blocked":
      return `**Blocked — it needed a person and nobody was there.**${suffix}`;
    case "failed":
      return `**Failed.**${suffix}`;
    case "exhausted":
      return `**Ran out of room before finishing.**${suffix}`;
    case "stopped":
      return `**Stopped.**${suffix}`;
    default:
      return `**Status: ${input.status}.**${suffix}`;
  }
}

/** The routing trace, and the reason this file exists. */
function routingSection(input: WalkthroughInput): string[] {
  const lines = [
    "## How it was routed",
    "",
    "| Turn | Step | Difficulty judged | Model | In | Out | Cost | Took |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: | ---: |"
  ];
  for (const turn of input.history) {
    const routing = turn.routing;
    const model = routing?.model ? `${routing.model}${routing.provider ? ` (${routing.provider})` : ""}` : DASH;
    lines.push(
      `| ${turn.index} | ${cell(turn.step)} | ${depthLabel(routing?.depth, routing?.promotedFrom)} | ${cell(model)} | ` +
        `${tokens(routing?.inputTokens, routing?.estimated)} | ${tokens(routing?.outputTokens, routing?.estimated)} | ` +
        `${turnCost(routing, input.pricing)} | ${seconds(routing?.durationMs)} |`
    );
  }

  const totalIn = input.history.reduce((sum, turn) => sum + (turn.routing?.inputTokens ?? 0), 0);
  const totalOut = input.history.reduce((sum, turn) => sum + (turn.routing?.outputTokens ?? 0), 0);
  const anyEstimated = input.history.some((turn) => turn.routing?.estimated);
  // Only turns Metis can actually price are summed, and the total says so.
  // Adding an unknown in as zero would understate the bill and look precise
  // doing it.
  let known = 0;
  let unpriced = 0;
  for (const turn of input.history) {
    const routing = turn.routing;
    if (!routing?.provider) continue;
    if (routing.provider === "ollama") continue;
    const found = input.pricing?.[`${routing.provider}::${routing.model ?? ""}`];
    if (!found) {
      unpriced += 1;
      continue;
    }
    known += ((routing.inputTokens ?? 0) * found.in + (routing.outputTokens ?? 0) * found.out) / 1_000_000;
  }
  const money = known >= 0.01 ? `$${known.toFixed(2)}` : known > 0 ? "<$0.01" : "$0.00";
  const caveat = unpriced ? ` — plus ${unpriced} turn${unpriced === 1 ? "" : "s"} on a model with no price in the catalogue` : "";

  lines.push("");
  lines.push(
    `**${input.history.length} turn${input.history.length === 1 ? "" : "s"}**, ` +
      `${tokens(totalIn, anyEstimated)} in and ${tokens(totalOut, anyEstimated)} out, ` +
      `costing **${money}**${caveat}.`
  );
  if (input.budgetTokens) {
    lines.push("");
    lines.push(`Budget was ${tokens(input.budgetTokens)} tokens.`);
  }
  const local = input.history.filter((turn) => turn.routing?.provider === "ollama").length;
  if (local && local < input.history.length) {
    lines.push("");
    lines.push(
      `${local} of those ${input.history.length} turns ran on a local model and cost nothing. ` +
        "That split is the point of routing: the cheap turns never reached a paid model."
    );
  }
  if (input.helpers?.length) {
    lines.push("");
    lines.push(
      `Plus ${input.helpers.length} parallel helper${input.helpers.length === 1 ? "" : "s"}, which are **not** in the table above — ` +
        "a helper runs in its own conversation rather than as a turn of this loop, so the totals here understate what the loop spent. " +
        "The budget ceiling does count them."
    );
    for (const helper of input.helpers) {
      lines.push(`- ${cell(helper.name)} — ${helper.status}${helper.task ? `: ${cell(helper.task)}` : ""}`);
    }
  }
  return lines;
}

function filesSection(input: WalkthroughInput): string[] {
  const rows: string[] = [];
  for (const turn of input.history) {
    for (const file of turn.files ?? []) {
      const churn =
        typeof file.addedLines === "number" || typeof file.removedLines === "number"
          ? `+${file.addedLines ?? 0} / -${file.removedLines ?? 0}`
          : DASH;
      rows.push(`| ${turn.index} | ${cell(file.path)} | ${file.kind === "create" ? "created" : "edited"} | ${churn} |`);
    }
  }
  if (!rows.length) return ["## What it wrote", "", "Nothing. No turn wrote a file."];
  const lines = [
    "## What it wrote",
    "",
    "| Turn | File | Change | Lines |",
    "| ---: | --- | --- | --- |",
    ...rows,
    "",
    // Deliberately points at the affordance rather than promising every write
    // was recoverable. Generated writes funnel through the snapshotted path,
    // but not every operation labelled file_create does — a generated image and
    // METIS-SPEC.md are both written directly — and a blanket guarantee in a
    // file the owner reads after the fact is the wrong place to be approximate.
    "Generated writes are backed up before they happen: **Settings → Privacy → Revert those files** restores the most recent backup. " +
      "It restores contents — files the run created are left in place rather than deleted."
  ];

  // The backups, named. Only turns that wrote through the snapshotted path
  // have one, so an absent row is a real fact about that turn rather than a
  // gap in the report.
  const snapshots = input.history.filter((turn) => turn.snapshot);
  if (snapshots.length) {
    lines.push("");
    lines.push("### The backups");
    lines.push("");
    for (const turn of snapshots) {
      lines.push(`- Turn ${turn.index} — \`${cell(turn.snapshot?.id ?? "")}\``);
      lines.push(`  \`${turn.snapshot?.dir ?? ""}\``);
    }
    lines.push("");
    // The honest limit, and the reason these paths are worth printing at all.
    // The revert control restores whichever backup was taken LAST, so for
    // every turn but the final one the folder above is the only way back —
    // copy the file out of it by hand. Naming an id without saying that would
    // imply a one-click undo that does not exist.
    lines.push(
      snapshots.length > 1
        ? "Each folder holds the originals of the files that turn was about to change. **Only the last one is reachable from the app** — " +
            "the revert control undoes the most recent write and nothing older, so for the earlier turns these paths are the way back: " +
            "open the folder and copy the file you want out of it."
        : "That folder holds the originals of the files this turn was about to change, which is the same backup the app's revert control uses."
    );
  }
  return lines;
}

/** What the run PROVED, as opposed to what it said. Only operations that could
 *  have failed appear here — see evidenceFromOperations for why a file write is
 *  not evidence of anything. */
function evidenceSection(input: WalkthroughInput): string[] {
  const lines: string[] = ["## What it checked", ""];
  const any = input.history.some((turn) => (turn.evidence ?? []).length);
  if (!any) {
    lines.push("Nothing ran that could report success or failure, so nothing here was verified — only asserted.");
    return lines;
  }
  for (const turn of input.history) {
    for (const item of turn.evidence ?? []) {
      const mark = item.status === "complete" ? "PASS" : item.status === "warning" ? "WARN" : "FAIL";
      const code = typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : "";
      lines.push(`- **${mark}** turn ${turn.index}: ${item.label}${code}`);
      if (item.detail) lines.push(`  \`\`\`\n  ${item.detail.split("\n").join("\n  ")}\n  \`\`\``);
    }
  }
  return lines;
}

function turnsSection(input: WalkthroughInput): string[] {
  const lines: string[] = ["## Turn by turn", ""];
  for (const turn of input.history) {
    const heading = turn.step ? `### Turn ${turn.index} — ${turn.step}` : `### Turn ${turn.index}`;
    lines.push(heading, "");
    if (turn.error) lines.push(`Failed: ${turn.error}`, "");
    if (turn.summary) lines.push(turn.summary, "");
    const verdict =
      turn.decision === "silent"
        ? "Asked for nothing, so the loop stopped — continuing is an explicit act."
        : `Decided **${turn.decision}**${turn.reason ? `: ${turn.reason}` : "."}`;
    lines.push(verdict, "");
    // Named, or explicitly not. Silence here would read as "an independent
    // judge checked it" on the turns where nothing of the kind happened.
    if (!turn.judgedBy) {
      lines.push("_Not independently judged — this turn carried its own decision._", "");
    } else {
      const note = turn.judgedBy.note ? ` (${cell(turn.judgedBy.note)})` : "";
      lines.push(
        turn.judgedBy.independent
          ? `Judged by **${cell(turn.judgedBy.model)}**, which did not do the work.${note}`
          : `Judged by **${cell(turn.judgedBy.model)}** — the same model that did the work.${note}`,
        ""
      );
    }
  }
  return lines;
}

/** Renders the whole file. */
export function formatWalkthrough(input: WalkthroughInput): string {
  const lines: string[] = [
    `${WALKTHROUGH_MARKER} loop=${input.loopId} -->`,
    "",
    "# What this loop did",
    "",
    `> ${input.goal.replace(/\r?\n/g, " ").trim() || "(no goal recorded)"}`,
    ""
  ];
  if (input.chain) lines.push(`Chain: \`${input.chain}\``, "");
  lines.push(verdictLine(input), "");
  lines.push(`Started ${input.createdAt}, finished ${input.finishedAt} (${elapsed(input.createdAt, input.finishedAt)}).`, "");
  if (input.projectPath) lines.push(`Worked in \`${input.projectPath}\`.`, "");
  lines.push("---", "");
  // Routing FIRST. See the file header for why this ordering is the whole
  // point rather than a layout preference.
  lines.push(...routingSection(input), "");
  lines.push(...filesSection(input), "");
  lines.push(...evidenceSection(input), "");
  lines.push(...turnsSection(input));
  lines.push("---", "", "Written by Metis Orchestrator when the loop settled. Safe to delete.", "");
  return lines.join("\n");
}

/** Which filename to write into the project root.
 *
 *  `walkthrough.md` is the name worth having, so Metis takes it — but only when
 *  it is free or already Metis's. A project that has its own `walkthrough.md`
 *  gets a suffixed file instead, because silently overwriting a document
 *  someone wrote is a worse failure than an ugly filename, and an unattended
 *  loop is exactly the situation where nobody is watching to undo it.
 *
 *  `existingHead` is the first few hundred bytes of the file already there, or
 *  null when there is none. */
export function walkthroughFileName(existingHead: string | null, loopId: string): string {
  const suffix = (loopId || "loop").replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "loop";
  if (existingHead === null) return "walkthrough.md";
  if (!existingHead.includes(WALKTHROUGH_MARKER)) return `walkthrough-metis-${suffix}.md`;
  // Metis's own, but possibly another loop's. Same loop overwrites its own
  // report; a different loop gets its own file rather than erasing a sibling's.
  return existingHead.includes(`loop=${loopId}`) ? "walkthrough.md" : `walkthrough-metis-${suffix}.md`;
}
