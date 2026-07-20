// Path containment, which is the check standing between "serve this project
// folder" and "serve whatever the caller asked for". Imports the REAL
// isPathInside from the build; the ad-hoc version copied the function body into
// the test, so it verified a snapshot rather than the shipped code.
//
// The bug it exists to prevent: a bare startsWith said "C:\project-secrets" was
// inside "C:\project", because the string genuinely does start with it. A
// sibling folder sharing a name prefix was readable.
//
// Paths are built with path.join so each OS tests its own real separator
// semantics. Hardcoded backslashes made two dot-dot cases fail on Linux CI:
// there a backslash is a legal filename character, so a backslash-joined
// "project\..\other" is one opaque segment that never normalises. That is not
// a bug in the app, which ships on Windows, but a suite must not go red for
// non-bugs. The prefix-attack and case-insensitivity properties hold on both
// platforms and are asserted on both.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, summary } from "../harness.mjs";
import { join, resolve, sep } from "node:path";

const { isPathInside, sameResolvedPath } = await fromBuild("shared/intent-and-paths.js");

// An absolute root native to whichever OS is running the suite.
const BASE = resolve(join(process.cwd(), "testroot"));
const ROOT = join(BASE, "project");

section("Legitimate paths are inside");
check("the root itself", isPathInside(ROOT, ROOT), true);
check("a direct child", isPathInside(join(ROOT, "app.js"), ROOT), true);
check("a nested child", isPathInside(join(ROOT, "src", "ui", "App.tsx"), ROOT), true);
check("forward slashes", isPathInside(`${ROOT}/src/app.js`, ROOT), true);
check("a trailing separator on the parent", isPathInside(join(ROOT, "app.js"), ROOT + sep), true);

section("THE PREFIX ATTACK: a sibling whose name merely starts the same");
check("project-secrets is NOT inside project", isPathInside(join(BASE, "project-secrets", "loot.txt"), ROOT), false);
check("projectX is NOT inside project", isPathInside(join(BASE, "projectX", "a.js"), ROOT), false);
check("project.bak is NOT inside project", isPathInside(join(BASE, "project.bak", "a.js"), ROOT), false);

section("Traversal and unrelated paths");
check("dot-dot escape", isPathInside(join(ROOT, "..", "other", "a.js"), ROOT), false);
check("dot-dot to a prefix sibling", isPathInside(join(ROOT, "..", "project-secrets", "loot.txt"), ROOT), false);
check("an unrelated absolute path", isPathInside(resolve(sep, "somewhere", "else", "file.txt"), ROOT), false);
check("the parent directory", isPathInside(BASE, ROOT), false);

section("Case handling");
// The implementation lowercases both sides, which is correct for Windows
// filesystems and a deliberate, documented trade elsewhere: two paths differing
// only by case compare equal. Asserted as the behaviour on every platform,
// because it is what the shipped code does.
check("different case is still inside", isPathInside(join(ROOT.toUpperCase(), "APP.JS"), ROOT), true);
check("sameResolvedPath ignores case", sameResolvedPath(ROOT, ROOT.toUpperCase()), true);

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
