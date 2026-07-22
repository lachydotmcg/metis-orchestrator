// Whether a request reaches the edit pipeline at all. Imports the REAL
// isEditIntent from the build: the ad-hoc version of this suite pasted the
// regex inline and compared it against an older inline regex, so it could
// never have caught main.ts drifting.
//
// The live failure this exists to prevent: "Extract the repeated localStorage
// key into a constant" matched nothing, stayed in plain chat, never read the
// file, and the model invented a plausible-but-wrong key name. Inventing rather
// than erroring is the worst failure mode available here.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, summary } from "../harness.mjs";

const { isEditIntent, isBuildQuestionGuard, hasStrongImperativeBuildLead } = await fromBuild("shared/intent-and-paths.js");

section("Refactoring vocabulary must route as an EDIT");
for (const prompt of [
  "The localStorage key string is repeated in three places. Extract it into a single named constant.",
  "Fix the duplicated localStorage key by using one constant.",
  "Consolidate the duplicated fetch logic into one helper.",
  "Simplify the createHabitCard function, it does too much.",
  "Rewrite the storage layer to use IndexedDB.",
  "Split app.js into separate modules.",
  "Turn this into a reusable component.",
  "Dedupe the repeated validation code.",
  "Streamline the render path.",
  "Migrate the styles to CSS variables.",
  "Implement a dark mode toggle.",
  "Ensure the delete button has an aria-label.",
  "Hoist the constant out of the loop.",
  "Factor out the shared header markup."
]) {
  check(`"${prompt.slice(0, 52)}..."`, isEditIntent(prompt), true);
}

section("Questions and discussion must NOT route as an edit");
for (const prompt of [
  "What does the calculateStreak function do?",
  "Why is my streak resetting at midnight?",
  "Explain how localStorage differs from sessionStorage.",
  "Walk me through the architecture of this project.",
  "How many functions does app.js define?",
  "Which browser APIs does this rely on?"
]) {
  check(`"${prompt.slice(0, 52)}"`, isEditIntent(prompt), false);
}

section("A bare noun is not an instruction");
check("the button", isEditIntent("the button"), false);
check("the header styling", isEditIntent("the header styling"), false);

section("QUESTION GUARD — statements opening with 'when'/'where' are not questions");
// The live miss this pins (devbox run B, 2026-07-21): a bug report opening
// with a temporal clause and ending in a direct edit order was read as a
// question and routed to chat — the user got a plan instead of changed files.
check("'When something goes wrong... Improve that.' is NOT a question",
  isBuildQuestionGuard("When something goes wrong in this app the user gets no feedback at all - failed requests just vanish. It feels unfinished. Improve that."), false);
check("'When I click the button nothing happens - fix it' is NOT a question",
  isBuildQuestionGuard("When I click the button nothing happens - fix it"), false);
check("'When did I create this file' IS a question", isBuildQuestionGuard("When did I create this file"), true);
check("'Where is the config loaded' IS a question", isBuildQuestionGuard("Where is the config loaded"), true);
check("'What was the name of the site I asked you to create' IS a question",
  isBuildQuestionGuard("What was the name of the site I asked you to create"), true);
check("'How many functions does app.js define?' IS a question", isBuildQuestionGuard("How many functions does app.js define?"), true);
check("advisory 'Walk me through the architecture' IS guarded", isBuildQuestionGuard("Walk me through the architecture of this project"), true);
check("direct build lead beats advisory tail",
  isBuildQuestionGuard("Build me a landing page and walk me through what you did"), false);
check("imperative lead helper agrees", hasStrongImperativeBuildLead("Build me a landing page"), true);
check("prose mention is not a lead", hasStrongImperativeBuildLead("I have been helping design a feature"), false);

section("ANALYSIS QUESTIONS are advisory, direct edit orders are not");
// From the 2026-07-21 depth sweep: an architecture-analysis question
// classified as coding and ran the file-writing build pipeline (which wrote
// nothing and said so — but the right surface was chat).
check("'Analyse the trade-offs... recommend a design' IS guarded",
  isBuildQuestionGuard("Analyse the architecture trade-offs of the file-based persistence under concurrent writes and recommend a more robust design."), true);
check("'Evaluate whether the store should use SQLite' IS guarded",
  isBuildQuestionGuard("Evaluate whether the store should use SQLite instead."), true);
check("'Compare the two approaches' IS guarded", isBuildQuestionGuard("Compare the two persistence approaches for me."), true);
check("'Fix the bug and explain what was wrong' is an ORDER",
  isBuildQuestionGuard("Fix the bug and explain what was wrong"), false);
check("'Update the header and describe the change' is an ORDER",
  isBuildQuestionGuard("Update the header and describe the change"), false);
check("'Improve this and analyse nothing' stays an order", isBuildQuestionGuard("Improve the error handling in this file"), false);

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
