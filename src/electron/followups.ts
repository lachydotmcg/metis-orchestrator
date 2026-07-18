/** Real follow-up suggestions and conversation titles, written by the SAME
 *  model that answered the turn (docs/DRILL_PLAN.md CORE.1 / CORE.2).
 *
 *  Replaces two pieces of fakery:
 *   - the canned heuristic suggestions ("Add a second page", "Continue the
 *     build") that ignored what was actually said, and
 *   - titling that always used the local model even when the answer came
 *     from a cloud model that understood the exchange far better.
 *
 *  Both run as SEPARATE calls after the answer, deliberately, rather than
 *  asking one response to carry answer + title + suggestions. Local tokens
 *  are free, and the live-testing round that produced "TEST_OK" being
 *  swallowed by a style instruction proved that small local models collapse
 *  under stacked instructions in a single response. One job per call.
 *
 *  The provider call is INJECTED so this module has no import edge back into
 *  main.ts (no cycles, and it stays unit-testable on its own). */

export type FollowupInvoke = (prompt: string) => Promise<{ output: string; source: string }>;

/** A model reply is only usable if a real provider produced it - main.ts
 *  returns source "placeholder" for "no key configured" / "Ollama is not
 *  running" style stubs, whose text would otherwise be parsed as content. */
function usableOutput(result: { output: string; source: string } | null): string | null {
  if (!result || result.source === "placeholder") return null;
  const trimmed = result.output.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Strips the decoration models wrap list items in: numbering ("1.", "2)"),
 *  bullets ("-", "*", "•"), surrounding quotes, and trailing punctuation.
 *  Also drops a leading "Suggestion:"-style label. */
function cleanSuggestionLine(raw: string): string {
  let line = raw.trim();
  line = line.replace(/^\s*(?:[-*•–]|\d+[.)])\s*/, "");
  line = line.replace(/^\s*(?:suggestion|follow[- ]?up|next)\s*\d*\s*[:.-]\s*/i, "");
  line = line.replace(/^["'`]+|["'`]+$/g, "");
  line = line.replace(/\s+/g, " ").trim();
  line = line.replace(/[.]+$/, "");
  return line;
}

/** Lines a model emits around a list that are not themselves suggestions:
 *  preambles, thinking leftovers, and markdown scaffolding. */
function isNoiseLine(line: string): boolean {
  if (!line) return true;
  if (line.length < 6) return true;
  if (/^(here|sure|okay|ok|certainly|of course|based on|these are|suggestions?|follow[- ]?ups?)\b/i.test(line)) return true;
  if (/^(<think|<\/think|```)/i.test(line)) return true;
  if (line.endsWith(":")) return true;
  return false;
}

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 78;

/** Asks the answering model for two or three things the user might genuinely
 *  say NEXT, phrased as the user would type them (first person, imperative),
 *  never as the assistant offering options. Returns [] on any failure or junk
 *  reply - the renderer shows nothing rather than a wrong guess. */
export async function generateFollowups(invoke: FollowupInvoke, userPrompt: string, assistantText: string): Promise<string[]> {
  try {
    const prompt = `You just gave this reply in a conversation. Write 3 short things the USER might realistically say next.

Rules:
- Write them as the USER would type them, in first person or as a direct instruction. Not as options you are offering.
- Each one must be a genuine next step given what was actually discussed. No generic filler.
- Maximum 9 words each.
- One per line. No numbering, no bullets, no quotes, no extra text before or after.

User said: ${userPrompt.slice(0, 1200)}

You replied: ${assistantText.slice(0, 2000)}`;

    const result = usableOutput(await invoke(prompt));
    if (!result) return [];

    // Drop any <think> block a reasoning model emitted before its list.
    const body = result.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const rawLine of body.split(/\r?\n/)) {
      const line = cleanSuggestionLine(rawLine);
      if (isNoiseLine(line)) continue;
      if (line.length > MAX_SUGGESTION_CHARS) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(line);
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }
    // One lonely suggestion usually means the model rambled instead of
    // listing; two or three is a real set. Below that, show nothing.
    return suggestions.length >= 2 ? suggestions : [];
  } catch {
    return [];
  }
}

const MAX_TITLE_WORDS = 6;
const MAX_TITLE_CHARS = 48;

/** Normalises a model's title reply: strips quotes/labels/trailing
 *  punctuation, collapses whitespace, caps the word count, and rejects
 *  anything that is obviously a refusal or a sentence rather than a title. */
export function cleanModelTitle(raw: string): string | null {
  let title = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Some models answer with a preamble line then the title; take the last
  // non-empty line, which is where the actual title lands.
  const lines = title.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  title = lines[lines.length - 1];
  title = title.replace(/^\s*(?:title)\s*[:.-]\s*/i, "");
  title = title.replace(/^["'`]+|["'`]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[.!?,;:]+$/, "");
  if (!title) return null;
  // A model that refused, or answered the question instead of titling it.
  if (/^(i (cannot|can't|am unable)|sorry|as an ai)\b/i.test(title)) return null;
  if (title.length > MAX_TITLE_CHARS * 2) return null;
  const words = title.split(" ").filter(Boolean);
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trim();
  return title.length >= 2 ? title : null;
}

/** Asks the answering model to name the conversation from the first exchange
 *  it just took part in. Returns null on any failure so the caller keeps its
 *  existing placeholder title. */
export async function generateConversationTitle(invoke: FollowupInvoke, userPrompt: string, assistantText: string): Promise<string | null> {
  try {
    const prompt = `Name this conversation with a short title of at most 6 words.

Rules:
- Describe the topic, not the interaction. "Habit tracker empty state" not "User asks for help".
- No quotes, no trailing punctuation, no prefix like "Title:".
- Reply with the title and nothing else.

User said: ${userPrompt.slice(0, 900)}

You replied: ${assistantText.slice(0, 900)}`;

    const result = usableOutput(await invoke(prompt));
    if (!result) return null;
    return cleanModelTitle(result);
  } catch {
    return null;
  }
}
