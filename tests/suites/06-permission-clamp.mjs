// The permission clamp decides what an unattended loop may do, so this suite
// imports the REAL clampPermissionMode from the build. It used to assert
// against an inline copy of the two freedom maps, which meant it agreed with
// itself no matter what main.ts actually did.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { clampPermissionMode, PERMISSION_WRITE_FREEDOM, PERMISSION_COMMAND_FREEDOM } = await fromBuild("shared/intent-and-paths.js");

const MODES = ["plan", "ask", "edits", "auto", "bypass"];

section("The escalation the code review caught");
check("edits requested under an auto ceiling resolves to auto", clampPermissionMode("edits", "auto"), "auto");
ok("  because edits writes with NO prompt while auto asks once", clampPermissionMode("edits", "auto") !== "edits");

section("Nothing escalates, across all 25 request/ceiling pairs");
let escalations = 0;
for (const ceiling of MODES) {
  for (const requested of MODES) {
    const got = clampPermissionMode(requested, ceiling);
    if (PERMISSION_WRITE_FREEDOM[got] > PERMISSION_WRITE_FREEDOM[ceiling]) escalations += 1;
    if (PERMISSION_COMMAND_FREEDOM[got] > PERMISSION_COMMAND_FREEDOM[ceiling]) escalations += 1;
  }
}
check("zero escalations on either axis", escalations, 0);

section("Asking for something tighter is still allowed");
check("plan under bypass", clampPermissionMode("plan", "bypass"), "plan");
check("plan under auto", clampPermissionMode("plan", "auto"), "plan");
check("ask under auto", clampPermissionMode("ask", "auto"), "ask");
check("ask under bypass", clampPermissionMode("ask", "bypass"), "ask");

section("Identity, and clamping down to the ceiling");
check("auto under auto", clampPermissionMode("auto", "auto"), "auto");
check("bypass under bypass", clampPermissionMode("bypass", "bypass"), "bypass");
check("bypass under ask", clampPermissionMode("bypass", "ask"), "ask");
check("bypass under plan", clampPermissionMode("bypass", "plan"), "plan");
check("auto under plan", clampPermissionMode("auto", "plan"), "plan");
check("edits under plan", clampPermissionMode("edits", "plan"), "plan");
check("edits under ask", clampPermissionMode("edits", "ask"), "ask");
check("auto under edits, since auto asks more for commands", clampPermissionMode("auto", "edits"), "edits");

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
