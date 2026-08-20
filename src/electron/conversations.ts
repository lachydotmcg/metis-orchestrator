/** Conversations: the record, its turns, and everything that edits them.
 *
 *  Seventh carve of docs/STRUCTURAL_DEBT.md item 1 — 531 lines for **seven**
 *  injected dependencies, the best ratio left in the file. The easy seams are
 *  gone; what remains is either the `runSession` hub (94 dependencies, not a
 *  seam) or electron shell code where carving would mean injecting electron
 *  itself one API at a time.
 *
 *  One of the seven is `showSaveDialog`, and it is injected for the rule that
 *  governs every carve here: a NAMED import from "electron" throws at load time
 *  in plain node, so importing `dialog` for one call would have made all 531
 *  lines unloadable — and `36-conversation-records` with them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { appendAudit, readStoreValue, writeStoreValue } from "./store.js";
import { invokeProvider } from "./providers.js";
import { generateConversationTitle } from "./followups.js";
import type {
  ConversationExportResult,
  ConversationRecord,
  ConversationTurnRecord,
  ProviderInvokeResult,
  ProviderKey,
  SessionRun
} from "../shared/runtime-contracts.js";

/** The seven. */
export interface ConversationDeps {
  readSessionRuns: () => Promise<SessionRun[]>;
  writeSessionRuns: (runs: SessionRun[]) => Promise<void>;
  claimPendingResources: (conversationId: string) => Promise<unknown>;
  localStageRef: () => StageModelRef;
  /** Builds the invoker auto-titling asks for a title with. Lives in main.ts
   *  because the loop runtime uses the same factory. */
  followupInvokerFor: (providerResult?: ProviderInvokeResult) => (prompt: string) => Promise<{ output: string; source: string }>;
  slugify: (value: string) => string;
  stripThinkBlocks: (value: string) => string;
  /** Electron's save dialog, injected rather than imported — see the module
   *  comment. One call site, and importing `dialog` for it would cost the whole
   *  module its testability. */
  showSaveDialog: (options: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePath?: string }>;
}

/** Structural twin — this module never reads inside a StageModelRef, it only
 *  hands one back from the injected localStageRef. */
type StageModelRef = { provider: ProviderKey; model: string; label?: string };

/** Two paths pointing at the same place, compared after resolution so a
 *  trailing slash or a relative segment does not read as a different project. */
function sameResolvedPath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return resolve(a) === resolve(b);
}

let injected: ConversationDeps | null = null;

/** Wire conversations. Called once from main.ts. */
export function configureConversations(deps: ConversationDeps): void {
  injected = deps;
}

function need(): ConversationDeps {
  if (!injected) throw new Error("Conversations were used before configureConversations() ran.");
  return injected;
}

export async function readConversations(): Promise<ConversationRecord[]> {
  return readStoreValue<ConversationRecord[]>("conversations", []);
}

export async function writeConversations(conversations: ConversationRecord[]): Promise<void> {
  await writeStoreValue("conversations", conversations.slice(0, 200));
}

/** Serialises conversation mutations and RE-READS inside the lock, the same
 *  shape and for the same reason as mutateLoops.
 *
 *  Every writer here was read-modify-write against a snapshot taken before an
 *  await. That is only a theoretical race while one turn runs at a time, and
 *  phase 2A stopped that being true: a loop turn can spawn up to three helpers,
 *  each of which is a full tracked run that appends to its own conversation
 *  through this same store. Four concurrent writers, each holding a snapshot
 *  from before its model call, and the slowest one wins — so a conversation
 *  turn that was written and displayed simply is not there after a restart.
 *
 *  The mutator must be pure and synchronous. Anything slow inside the lock
 *  (a model call, a file scan) serialises the whole app's chat history behind
 *  it, which trades a rare lost turn for a guaranteed stall.
 *
 *  Process-local, exactly like mutateLoops: two Metis processes sharing one
 *  store still race, and nothing here pretends otherwise. That is why the CLI
 *  is given its own loop origin rather than sharing the app's. */
let conversationMutationQueue: Promise<unknown> = Promise.resolve();

export function mutateConversations<T>(
  mutator: (current: ConversationRecord[]) => { next: ConversationRecord[]; result: T }
): Promise<T> {
  const run = conversationMutationQueue.then(async () => {
    const current = await readConversations();
    const { next, result } = mutator(current);
    await writeConversations(next);
    return result;
  });
  // The chain must survive a failed mutation, or one throw wedges every later
  // conversation write for the life of the process.
  conversationMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function conversationTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim();
  return cleaned.split(" ").slice(0, 7).join(" ") || "New session";
}

export async function createConversation(projectPath?: string, firstPrompt?: string): Promise<ConversationRecord> {
  const now = new Date().toISOString();
  const conversation: ConversationRecord = {
    id: randomUUID(),
    projectPath,
    title: firstPrompt ? conversationTitle(firstPrompt) : "New session",
    createdAt: now,
    updatedAt: now,
    turns: []
  };
  await mutateConversations((current) => ({ next: [conversation, ...current], result: undefined }));
  return conversation;
}

export async function deleteConversation(id: string): Promise<ConversationRecord[]> {
  const { conversation, next } = await mutateConversations((current) => {
    const found = current.find((item) => item.id === id);
    const remaining = current.filter((item) => item.id !== id);
    return { next: remaining, result: { conversation: found, next: remaining } };
  });

  // Session runs are a DIFFERENT store, so this stays outside the conversation
  // lock: holding one store's lock across another store's read and write is how
  // two locks become a deadlock the first time the other store wants this one.
  const deletedRunIds = new Set(conversation?.turns.map((turn) => turn.runId).filter(Boolean) ?? []);
  const runs = await need().readSessionRuns();
  await need().writeSessionRuns(runs.filter((run) => run.conversationId !== id && !deletedRunIds.has(run.id)));

  if (conversation) {
    await appendAudit("info", "conversation.delete", `Deleted conversation ${conversation.title}.`, {
      id,
      projectPath: conversation.projectPath
    });
  }
  return next;
}

/** Conversation FORK (docs/DRILL_PLAN.md I9.5): copies a conversation into a
 *  new one - all turns, or only up to (and including) the turn that carries
 *  `uptoRunId` when given. Turn copies DROP their runId on purpose:
 *  deleteConversation removes session runs by the deleted turns' runIds, so a
 *  forked copy sharing ids would let deleting the fork nuke the SOURCE's run
 *  records. The embedded `run` snapshot stays for display. Pairs with
 *  per-conversation model memory: fork the same context onto a different
 *  model and compare (the renderer copies the model mapping). */
export async function forkConversation(id: string, uptoRunId?: string): Promise<ConversationRecord | null> {
  const now = new Date().toISOString();
  const forked = await mutateConversations((current) => {
    const source = current.find((item) => item.id === id);
    // A no-op still has to return the list unchanged: the mutator's `next` is
    // written unconditionally, so returning anything else here would persist it.
    if (!source) return { next: current, result: null };
    let cut = source.turns.length;
    if (uptoRunId) {
      const index = source.turns.findIndex((turn) => turn.runId === uptoRunId);
      if (index >= 0) cut = index + 1;
    }
    const fork: ConversationRecord = {
      id: randomUUID(),
      projectPath: source.projectPath,
      title: `${source.title} (fork)`,
      createdAt: now,
      updatedAt: now,
      turns: source.turns.slice(0, cut).map(({ runId: _dropped, ...turn }) => ({ ...turn, id: randomUUID() })),
      // The fork title is derived and deliberate - never auto-retitled.
      titleManual: true,
      autoTitleAttempted: true
    };
    return { next: [fork, ...current], result: { fork, sourceTitle: source.title } };
  });
  if (!forked) return null;
  await appendAudit("info", "conversation.fork", `Forked conversation "${forked.sourceTitle}" (${forked.fork.turns.length} turns).`, {
    sourceId: id,
    forkId: forked.fork.id
  });
  return forked.fork;
}

export async function renameConversation(id: string, title: string): Promise<ConversationRecord[]> {
  const trimmed = title.trim();
  const { changed, next } = await mutateConversations((current) => {
    const conversation = current.find((item) => item.id === id);
    if (!conversation || !trimmed) return { next: current, result: { changed: false, next: current } };
    const updated = current.map((item) => (item.id === id ? { ...item, title: trimmed, titleManual: true } : item));
    return { next: updated, result: { changed: true, next: updated } };
  });
  if (changed) await appendAudit("info", "conversation.rename", `Renamed conversation to "${trimmed}".`, { id });
  return next;
}

export async function archiveConversation(id: string, archived: boolean): Promise<ConversationRecord[]> {
  const { title, next } = await mutateConversations((current) => {
    const conversation = current.find((item) => item.id === id);
    if (!conversation) return { next: current, result: { title: null as string | null, next: current } };
    const updated = current.map((item) => (item.id === id ? { ...item, archived } : item));
    return { next: updated, result: { title: conversation.title, next: updated } };
  });
  if (title !== null) {
    await appendAudit("info", "conversation.archive", `${archived ? "Archived" : "Unarchived"} conversation ${title}.`, {
      id,
      archived
    });
  }
  return next;
}

export function conversationToMarkdown(record: ConversationRecord): string {
  const lines: string[] = [];
  lines.push(`# ${record.title || "Untitled conversation"}`);
  lines.push("");
  const meta = [`Created ${record.createdAt}`, `Updated ${record.updatedAt}`];
  if (record.projectPath) meta.push(`Project: ${record.projectPath}`);
  lines.push(`_${meta.join(" · ")}_`);
  lines.push("");
  for (const turn of record.turns) {
    lines.push(turn.role === "user" ? "## You" : "## Metis");
    lines.push(`_${turn.createdAt}_`);
    lines.push("");
    lines.push((turn.content ?? "").trim() || "_(empty)_");
    if (turn.run) {
      const runMeta: string[] = [];
      if (turn.run.pipelineName) runMeta.push(`pipeline: ${turn.run.pipelineName}`);
      if (turn.run.routeLabel) runMeta.push(`route: ${turn.run.routeLabel}`);
      if (runMeta.length > 0) {
        lines.push("");
        lines.push(`> ${runMeta.join(" · ")}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function exportConversationsMarkdown(conversationId?: string): Promise<ConversationExportResult> {
  try {
    const conversations = await readConversations();
    let markdown: string;
    let defaultName: string;
    let auditSummary: string;

    if (conversationId) {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (!conversation) return { ok: false, error: "That conversation no longer exists." };
      markdown = conversationToMarkdown(conversation);
      defaultName = `${need().slugify(conversation.title || "conversation")}.md`;
      auditSummary = `Exported conversation "${conversation.title}" to Markdown.`;
    } else {
      if (conversations.length === 0) return { ok: false, error: "There are no conversations to export." };
      markdown = conversations.map((conversation) => conversationToMarkdown(conversation)).join("\n---\n\n");
      defaultName = "metis-conversations.md";
      auditSummary = `Exported ${conversations.length} conversation${conversations.length === 1 ? "" : "s"} to Markdown.`;
    }

    const result = await need().showSaveDialog({
      title: "Export conversation as Markdown",
      defaultPath: defaultName,
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "All Files", extensions: ["*"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

    await mkdir(dirname(result.filePath), { recursive: true });
    await writeFile(result.filePath, markdown, "utf8");
    await appendAudit("info", "conversation.export", auditSummary, { conversationId, path: result.filePath });

    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function conversationProjectMatches(conversation: ConversationRecord, projectPath?: string): boolean {
  if (!projectPath) return !conversation.projectPath;
  return Boolean(conversation.projectPath) && sameResolvedPath(conversation.projectPath ?? "", projectPath);
}

export async function deleteProjectConversations(projectPath?: string): Promise<ConversationRecord[]> {
  const { deleted, next } = await mutateConversations((current) => {
    const removed = current.filter((conversation) => conversationProjectMatches(conversation, projectPath));
    const kept = current.filter((conversation) => !conversationProjectMatches(conversation, projectPath));
    return { next: kept, result: { deleted: removed, next: kept } };
  });

  // Session runs are a separate store, cleaned outside the conversation lock.
  const deletedConversationIds = new Set(deleted.map((conversation) => conversation.id));
  const deletedRunIds = new Set(deleted.flatMap((conversation) => conversation.turns.map((turn) => turn.runId).filter(Boolean)));
  const runs = await need().readSessionRuns();
  await need().writeSessionRuns(
    runs.filter((run) => {
      const sameProject = projectPath
        ? Boolean(run.projectPath) && sameResolvedPath(run.projectPath ?? "", projectPath)
        : !run.projectPath;
      return !sameProject && !deletedConversationIds.has(run.conversationId ?? "") && !deletedRunIds.has(run.id);
    })
  );

  if (deleted.length > 0) {
    await appendAudit("info", "project.conversations.delete", `Deleted ${deleted.length} conversation${deleted.length === 1 ? "" : "s"} for a project.`, {
      projectPath,
      count: deleted.length
    });
  }
  return next;
}

export async function appendRunToConversation(run: SessionRun, prompt: string): Promise<string> {
  // Serialised, because this is the one conversation writer that concurrent
  // runs all reach: a loop turn and each of its up-to-three helpers append
  // through here at once. Read-modify-write against a pre-await snapshot lost
  // whichever turn finished first.
  // A loop turn is a conversation turn, and this is where it stops looking like
  // one the user typed (docs/ROADMAP.md). Two substitutions, both refusals to
  // put words in the owner's mouth:
  //
  //  - The stored "user" content becomes the loop's own label, never the wake
  //    prompt. The wake prompt is the goal plus a history digest plus the
  //    helper list plus the artifact plus the protocol block — Metis writing to
  //    itself — and attributing that to the person is the single most misleading
  //    thing this function could do.
  //  - A conversation CREATED by a loop is titled from the goal rather than
  //    from that same wake prompt, which would otherwise name the thread after
  //    its own scaffolding.
  const loopMark =
    run.loopId && run.loopTurn ? { id: run.loopId, turn: run.loopTurn.index, label: run.loopTurn.label } : undefined;

  const { id, created } = await mutateConversations((current) => {
    const existing = run.conversationId ? current.find((item) => item.id === run.conversationId) : undefined;
    const conversation: ConversationRecord = existing ?? {
      id: run.conversationId ?? randomUUID(),
      projectPath: run.projectPath,
      title: conversationTitle(loopMark ? loopMark.label : prompt),
      createdAt: run.createdAt,
      updatedAt: run.completedAt,
      turns: []
    };

    const userTurn: ConversationTurnRecord = {
      id: randomUUID(),
      role: "user",
      createdAt: run.createdAt,
      content: loopMark ? loopMark.label : prompt,
      runId: run.id,
      ...(loopMark ? { loop: loopMark } : {})
    };
    const assistantTurn: ConversationTurnRecord = {
      id: randomUUID(),
      role: "assistant",
      createdAt: run.completedAt,
      content: run.assistantText,
      runId: run.id,
      run,
      ...(loopMark ? { loop: loopMark } : {})
    };
    const nextConversation: ConversationRecord = {
      ...conversation,
      projectPath: run.projectPath ?? conversation.projectPath,
      updatedAt: run.completedAt,
      turns: [...conversation.turns, userTurn, assistantTurn]
    };
    return {
      next: [nextConversation, ...current.filter((item) => item.id !== nextConversation.id)],
      result: { id: nextConversation.id, created: !existing }
    };
  });

  // Per-conversation resources (Lachy): anything attached on the new session
  // page (the pending bucket) belongs to the conversation that first message
  // just created. Fail-soft — resources are never run-critical.
  //
  // Deliberately AFTER the lock rather than inside it. The mutator has to stay
  // synchronous: an await in there serialises every conversation write in the
  // app behind a filesystem call, which trades a rare lost turn for a reliable
  // stall. The claim runs a moment later than it used to and now finds the
  // conversation already persisted, which is if anything the safer order.
  if (created) {
    try {
      await need().claimPendingResources(id);
    } catch {
      /* best-effort */
    }
  }
  return id;
}

/** A prompt too short/thin to summarise meaningfully ("hi", "test", "yo") —
 *  auto-titling would just reproduce the existing first-prompt-slice title,
 *  so skip calling the model and leave the placeholder title in place. */
export function isTrivialTitlePrompt(prompt: string): boolean {
  const words = prompt.split(/\s+/).filter(Boolean);
  return words.length <= 2 && prompt.length <= 12;
}

/** Marks a conversation as "auto-title attempted" without changing its title
 *  — used for the trivial-prompt skip so we never re-attempt on later turns. */
async function markAutoTitleAttempted(conversationId: string): Promise<void> {
  await mutateConversations((current) => ({
    next: current.map((item) => (item.id === conversationId ? { ...item, autoTitleAttempted: true } : item)),
    result: undefined
  }));
}

/** Normalises a raw local-model title reply into a clean, short, Title-Case-ish
 *  string: first line only, quotes/trailing punctuation stripped, capped at 6
 *  words. Returns null for anything that doesn't look like a real title (empty,
 *  too long/rambling, or unparseable), so the caller can fall back safely. */
export function cleanGeneratedTitle(raw: string): string | null {
  let text = need().stripThinkBlocks(raw).split("\n")[0] ?? "";
  text = text.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  text = text.replace(/[.!?;:,]+$/g, "").trim();
  text = text.replace(/\s+/g, " ");
  if (!text || text.length > 80) return null;
  const words = text.split(" ").filter(Boolean).slice(0, 6);
  if (words.length === 0) return null;
  const titled = words.map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(" ");
  return titled.length >= 2 ? titled : null;
}

/** Calls the local Ollama model (localStageRef — always free/local, never a
 *  paid cloud call) with a tight titling prompt built from the first exchange.
 *  Fails soft: any provider error, placeholder result, or unparseable reply
 *  returns null so the caller falls back to the first-prompt-slice title. */
export async function generateLocalTitle(prompt: string, assistantText: string): Promise<string | null> {
  try {
    const ref = need().localStageRef();
    const titlePrompt = `Summarise this conversation as a short title of at most 6 words, no quotes, no punctuation at the end. Reply with only the title.

User: ${prompt.slice(0, 800)}
Assistant: ${assistantText.slice(0, 800)}`;
    const result = await invokeProvider({ provider: ref.provider, model: ref.model, prompt: titlePrompt });
    if (result.source === "placeholder" || !result.output.trim()) return null;
    return cleanGeneratedTitle(result.output);
  } catch {
    return null;
  }
}


export async function maybeAutoTitleConversation(conversationId: string, firstPrompt: string, assistantText: string, providerResult?: ProviderInvokeResult): Promise<void> {
  try {
    const current = await readConversations();
    const conversation = current.find((item) => item.id === conversationId);
    if (!conversation) return;
    if (conversation.titleManual || conversation.autoTitleAttempted) return;
    // Only the conversation's first exchange (one user turn + one assistant
    // turn) should ever trigger auto-titling.
    if (conversation.turns.length !== 2) return;

    const trimmedPrompt = firstPrompt.trim();
    if (isTrivialTitlePrompt(trimmedPrompt)) {
      await markAutoTitleAttempted(conversationId);
      return;
    }

    // CORE.2 (Lachy: "the model you send your message to will read the
    // message, set the title separately and respond"): name the conversation
    // with the model that ANSWERED it. A cloud model that just understood the
    // exchange writes a far better title than whatever local model happened
    // to be the default. Falls back to the local titler, then to the raw
    // prompt slice, so this can only ever improve on the old behaviour.
    const generated =
      (await generateConversationTitle(need().followupInvokerFor(providerResult), trimmedPrompt, assistantText)) ??
      (await generateLocalTitle(trimmedPrompt, assistantText));
    const finalTitle = generated ?? conversationTitle(trimmedPrompt);

    // The re-read and the write happen INSIDE the lock, which is what this
    // originally wanted. It used to re-read just before writing, and that
    // narrowed the window without closing it: a rename landing between the
    // re-read and the write still lost. The titling model call takes seconds,
    // so this is the widest window in the file and the likeliest of these to
    // have actually bitten someone.
    await mutateConversations((latest) => {
      const latestConversation = latest.find((item) => item.id === conversationId);
      if (!latestConversation || latestConversation.titleManual || latestConversation.autoTitleAttempted) {
        return { next: latest, result: undefined };
      }
      return {
        next: latest.map((item) => (item.id === conversationId ? { ...item, title: finalTitle, autoTitleAttempted: true } : item)),
        result: undefined
      };
    });
  } catch {
    // Titling must never surface as a run failure — swallow everything.
  }
}
