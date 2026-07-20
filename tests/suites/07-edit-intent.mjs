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

const { isEditIntent } = await fromBuild("shared/intent-and-paths.js");

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

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
