/**
 * Two pure predicates lifted out of main.ts so they can be TESTED against the
 * real implementation.
 *
 * They were being covered by suites that pasted a copy of each regex inline and
 * asserted against that. Those suites passed whatever main.ts did, because they
 * never touched it: change the real code and the copy still agrees with itself.
 * A test that cannot fail when the code breaks is decoration.
 *
 * Both are pure (string in, boolean out) with no Electron or filesystem
 * dependency, which is exactly why they were the two worth moving. main.ts
 * imports them from here now, so the tests and the app read the same source.
 */

import { resolve } from "node:path";
import type { PermissionMode } from "./runtime-contracts.js";

/** Permission modes are NOT totally ordered, which a single "looseness" list
 *  got wrong. "edits" lets file writes through with no prompt while still
 *  asking for commands; "auto" asks once per new scope for BOTH. So "edits" is
 *  looser than "auto" for writes and tighter for commands, and neither is
 *  simply above the other. A linear ranking that put "edits" below "auto" let a
 *  caller asking for "edits" past an "auto" ceiling and silently gain
 *  unprompted write access on an unattended run. */
export const PERMISSION_WRITE_FREEDOM: Record<PermissionMode, number> = { plan: 0, ask: 1, auto: 2, edits: 3, bypass: 4 };
export const PERMISSION_COMMAND_FREEDOM: Record<PermissionMode, number> = { plan: 0, ask: 1, edits: 1, auto: 2, bypass: 3 };

/** Returns the requested mode when it is no looser than the ceiling on BOTH
 *  axes, and the ceiling otherwise. A caller can always ask for something
 *  tighter (a plan-only loop is a perfectly reasonable thing to want), never
 *  for something looser, and never for something that trades one freedom for
 *  another. Incomparable pairs resolve to the ceiling, which is the safe side. */
export function clampPermissionMode(requested: PermissionMode, ceiling: PermissionMode): PermissionMode {
  const writeOk = PERMISSION_WRITE_FREEDOM[requested] <= PERMISSION_WRITE_FREEDOM[ceiling];
  const commandOk = PERMISSION_COMMAND_FREEDOM[requested] <= PERMISSION_COMMAND_FREEDOM[ceiling];
  return writeOk && commandOk ? requested : ceiling;
}

/** Whether a request is asking to CHANGE existing code rather than discuss it.
 *
 *  This list decides whether a request reaches the edit pipeline at all, and it
 *  was once missing most refactoring vocabulary. A CLI sweep proved the cost:
 *  "Extract the repeated localStorage key into a constant" matched NOTHING,
 *  stayed in plain chat, never read the file, and the model HALLUCINATED a
 *  plausible-but-wrong key name. Reworded as "FIX the duplicated key" it
 *  matched, routed correctly, and did a clean surgical edit. Same intent,
 *  different verb, opposite outcome, and the failure mode was inventing rather
 *  than erroring, which is the worst kind.
 *
 *  Verb-anchored on purpose: a bare noun like "the button" must not trigger an
 *  edit. It is just no longer blind to how engineers actually phrase changes. */
export const EDIT_INTENT_PATTERN =
  /\b(fix|repair|change|update|tweak|adjust|edit|modify|revise|rework|restyle|refactor|rename|resize|reposition|realign|recolou?r|re-?colour|move|replace|swap|add|remove|delete|insert|improve|polish|clean\s?up|shorten|expand|space\s?out|align|cent(er|re)|make\s+(it|the|them)|give\s+(it|the)|extract|consolidat(e|ing)|dedupe|deduplicat(e|ing)|simplify|streamline|tidy|rewrite|convert|migrat(e|ing)|split|merge|combine|unify|standardi[sz]e|normali[sz]e|rearrange|reorder|reorgani[sz]e|restructure|wrap|inline|hoist|pull\s+(it|the|this)?\s*(out|up)|factor\s+out|use\s+(a|an|one|the)\s+\w+\s+(instead|constant|variable|helper)|turn\s+(it|the|this)\s+into|implement|handle|support|ensure|prevent|disable|enable)\b/i;

export function isEditIntent(prompt: string): boolean {
  return EDIT_INTENT_PATTERN.test(prompt);
}

// Advisory/explanatory asks — "walk me through...", "explain...", "give me a
// skeleton..." — want an ANSWER in chat, not a file-writing build run. These
// prompts often mention a build verb or artifact noun somewhere in the prose,
// which is exactly what makes them slip past the plain build/edit heuristics.
// Moved here from main.ts (2026-07-21) so the offline suites can pin the
// question-guard behaviour — it had a live miss the day it moved.
export const ADVISORY_INTENT_RE =
  /\b(?:walk (?:me )?through|talk (?:me )?through|explain|describe|outline|analy[sz]e|assess|evaluate|compare|weigh (?:up )?the\b|recommend (?:a|an|the)\b|how (?:would|do|should|can) i\b|how to\b|what(?:'s| is| are| should| would) the best\b|give me (?:a|an)\b[\s\S]{0,40}?\b(?:skeleton|example|outline|overview|rundown|starting point|sketch|idea)\b|help me (?:understand|think|plan|design)\b|should i\b)/i;

/** True when the prompt OPENS with an unambiguous, direct build or edit
 *  order, which outranks advisory-sounding phrasing later in the same prompt
 *  ("Fix the bug and explain what was wrong" is an order, not a question).
 *  The edit verbs joined the list in the 2026-07-21 depth sweep, the same
 *  round that taught ADVISORY_INTENT_RE the analysis verbs — "Analyse the
 *  architecture trade-offs... and recommend a design" was classifying as
 *  coding and running the file-writing build pipeline, which wrote nothing
 *  and reported it honestly, but the right surface was chat all along. */
export function hasStrongImperativeBuildLead(prompt: string): boolean {
  return /^\s*(?:build|make|create|design|generate|develop|scaffold|implement|fix|repair|correct|update|improve|refactor)\b(?:\s+(?:me|us))?\s+(?:a|an|the|this|that|my|our)\b/i.test(prompt);
}

/** True for prompts that are QUESTIONS about the project rather than orders
 *  to change it — the guard that keeps "what's the status of my site?" from
 *  triggering a build.
 *
 *  "when" and "where" are deliberately NOT in the plain opener list: they
 *  open subordinate clauses in ordinary statements — live devbox run B
 *  (2026-07-21) began "When something goes wrong in this app..." and ended
 *  "Improve that.", a direct edit order, and the old opener rule routed it
 *  to chat where the user got a plan instead of changed files. Interrogative
 *  "when/where" is followed by an auxiliary ("When did I...", "Where is
 *  the..."), and only that form is guarded. */
export function isBuildQuestionGuard(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^\s*(what|which|who|whose|why|how|did|was|were|is|are|does|do)\b/i.test(trimmed)) return true;
  if (/^\s*(when|where)\s+(did|does|do|is|are|was|were|will|would|can|could|should|has|have|had|am)\b/i.test(trimmed)) return true;
  if (/\?\s*$/.test(trimmed) && /\b(asked|created|built|made|generated|wrote)\b/i.test(trimmed)) return true;
  // Advisory ask wins UNLESS the prompt itself opens with a direct
  // imperative build order — then the direct order is the primary ask.
  if (ADVISORY_INTENT_RE.test(trimmed) && !hasStrongImperativeBuildLead(trimmed)) return true;
  return false;
}

export function sameResolvedPath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** Containment check for every path the app is asked to touch.
 *
 *  The separator is the whole point. A bare `startsWith` said
 *  "C:\project-secrets" was inside "C:\project", because the string genuinely
 *  starts with it. That is a real traversal: a sibling folder whose name merely
 *  shares a prefix was readable. The trailing separator closes it, and both
 *  slash styles are checked because Windows accepts either. */
export function isPathInside(child: string, parent: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  if (sameResolvedPath(childResolved, parentResolved)) return true;
  const parentWithSep = parentResolved.endsWith("\\") || parentResolved.endsWith("/") ? parentResolved : `${parentResolved}\\`;
  return childResolved.toLowerCase().startsWith(parentWithSep.toLowerCase()) || childResolved.toLowerCase().startsWith(`${parentResolved.toLowerCase()}/`);
}
