// Conversation titles and records — the text a person actually navigates by.
//
// A conversation's title is the only handle on it in the sidebar. Every failure
// here is one you live with rather than one you notice: a title that is the
// first seven words of a paragraph, a model-generated title that arrives with
// the quotes still on it, or an empty string that leaves a blank row you cannot
// tell from its neighbours.
//
// None of it was reachable until the carve (docs/STRUCTURAL_DEBT.md item 1) put
// these functions in a module that does not import electron. The one electron
// call in the whole block — `dialog.showSaveDialog`, for exporting — is injected
// precisely so this file can load.
//
// Offline: no provider is called, no model generates anything, no key is read.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const c = await fromBuild("electron/conversations.js");
const store = await fromBuild("electron/store.js");

const root = mkdtempSync(join(tmpdir(), "metis-conv-test-"));
store.configureStore(root);

const saveDialogCalls = [];
c.configureConversations({
  readSessionRuns: async () => [],
  writeSessionRuns: async () => {},
  claimPendingResources: async () => [],
  localStageRef: () => ({ provider: "ollama", model: "qwen3:8b" }),
  slugify: (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  // The real one strips <think> blocks; a faithful fake matters because
  // cleanGeneratedTitle runs its output straight into a title.
  stripThinkBlocks: (v) => v.replace(/<think>[\s\S]*?<\/think>/gi, ""),
  followupInvokerFor: () => async () => ({ output: "", source: "test" }),
  showSaveDialog: async (options) => {
    saveDialogCalls.push(options);
    return { canceled: true };
  }
});

section("A fallback title is derived from the prompt, and never empty");
{
  check("ordinary prompt", c.conversationTitle("build me a todo app"), "build me a todo app");
  // Seven words is the cap — a paragraph must not become the sidebar row.
  const long = c.conversationTitle("one two three four five six seven eight nine ten");
  check("capped at seven words", long.split(" ").length, 7);

  // Punctuation is stripped so a title cannot end mid-symbol, and whitespace is
  // collapsed so a pasted prompt does not produce a ragged row.
  check("punctuation goes", c.conversationTitle("what?! is *this*"), "what is this");
  check("newlines collapse", c.conversationTitle("first line\n\nsecond line"), "first line second line");

  // THE ONE THAT MATTERS: a prompt made entirely of punctuation or whitespace
  // strips to nothing, and an empty title is a blank sidebar row you cannot
  // tell from its neighbours.
  check("punctuation only falls back", c.conversationTitle("???!!!"), "New session");
  check("empty falls back", c.conversationTitle(""), "New session");
  check("whitespace only falls back", c.conversationTitle("   \n  "), "New session");
  ok("hyphens and underscores survive, since code prompts use them", c.conversationTitle("fix user_auth flow").includes("user_auth"));
}

section("A model-generated title is cleaned, or refused");
{
  check("plain text passes, title-cased", c.cleanGeneratedTitle("todo app build"), "Todo App Build");

  // Models return titles wrapped in quotes constantly, including smart quotes.
  check("straight quotes are stripped", c.cleanGeneratedTitle('"Todo App"'), "Todo App");
  check("smart quotes too", c.cleanGeneratedTitle("“Todo App”"), "Todo App");
  check("trailing punctuation goes", c.cleanGeneratedTitle("Todo App."), "Todo App");

  // Only the first line — a model that explains itself must not put its
  // reasoning in the sidebar.
  check("only the first line is used", c.cleanGeneratedTitle("Todo App\nHere is why I chose that"), "Todo App");
  // And <think> blocks are stripped before any of that.
  check("think blocks are removed first", c.cleanGeneratedTitle("<think>hmm</think>Todo App"), "Todo App");

  check("capped at six words", c.cleanGeneratedTitle("one two three four five six seven eight").split(" ").length, 6);

  // Refusals return null so the caller keeps the prompt-derived fallback rather
  // than showing something useless.
  check("empty is refused", c.cleanGeneratedTitle(""), null);
  check("whitespace is refused", c.cleanGeneratedTitle("   "), null);
  check("a single character is refused", c.cleanGeneratedTitle("x"), null);
  check("an essay is refused", c.cleanGeneratedTitle("y".repeat(200)), null);
  check("and quotes around nothing are refused", c.cleanGeneratedTitle('""'), null);
}

section("A prompt too thin to title is not sent to a model");
{
  // Asking a model to title "hi" wastes a call to produce something worse than
  // the prompt itself.
  ok('"hi" is trivial', c.isTrivialTitlePrompt("hi"));
  ok('"thanks" is trivial', c.isTrivialTitlePrompt("thanks"));
  ok("two short words are trivial", c.isTrivialTitlePrompt("ok cool"));
  ok("a real request is not", !c.isTrivialTitlePrompt("build me a todo app with tags"));
  // Three words is past the cap even when short — the length AND the word count
  // both have to be small.
  ok("three words are not trivial", !c.isTrivialTitlePrompt("a b c"));
  ok("one long word is not trivial", !c.isTrivialTitlePrompt("supercalifragilistic"));
}

section("Records round-trip through the store");
{
  const created = await c.createConversation(undefined, "build me a todo app");
  ok("a conversation gets an id", typeof created.id === "string" && created.id.length > 0);
  ok("and a title from the prompt", created.title.length > 0);

  const listed = await c.readConversations();
  check("it is stored", listed.length, 1);

  await c.renameConversation(created.id, "Renamed");
  check("renaming sticks", (await c.readConversations())[0].title, "Renamed");

  await c.createConversation(undefined, "second one");
  check("two now", (await c.readConversations()).length, 2);

  await c.deleteConversation(created.id);
  const after = await c.readConversations();
  check("deleting removes one", after.length, 1);
  ok("and leaves the other", after[0].id !== created.id);

  ok("deleting something absent does not throw", (await c.deleteConversation("no-such-id")) !== undefined || true);
}

section("Export asks the injected dialog, not electron");
{
  saveDialogCalls.length = 0;
  const result = await c.exportConversationsMarkdown();
  ok("the dialog was consulted", saveDialogCalls.length === 1);
  // Cancelling must not be reported as a successful export.
  ok("a cancelled save is not a success", result?.ok !== true);
}

rmSync(root, { recursive: true, force: true });

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
