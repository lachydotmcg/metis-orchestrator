// Path containment, which is the check standing between "serve this project
// folder" and "serve whatever the caller asked for". Imports the REAL
// isPathInside from the build; the ad-hoc version copied the function body into
// the test, so it verified a snapshot rather than the shipped code.
//
// The bug it exists to prevent: a bare startsWith said "C:\project-secrets" was
// inside "C:\project", because the string genuinely does start with it. A
// sibling folder sharing a name prefix was readable.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, summary } from "../harness.mjs";

const { isPathInside, sameResolvedPath } = await fromBuild("shared/intent-and-paths.js");

const ROOT = "C:\\Users\\me\\project";

section("Legitimate paths are inside");
check("the root itself", isPathInside(ROOT, ROOT), true);
check("a direct child", isPathInside(`${ROOT}\\app.js`, ROOT), true);
check("a nested child", isPathInside(`${ROOT}\\src\\ui\\App.tsx`, ROOT), true);
check("forward slashes", isPathInside(`${ROOT}/src/app.js`, ROOT), true);
check("a trailing separator on the parent", isPathInside(`${ROOT}\\app.js`, `${ROOT}\\`), true);

section("THE PREFIX ATTACK: a sibling whose name merely starts the same");
check("project-secrets is NOT inside project", isPathInside("C:\\Users\\me\\project-secrets\\loot.txt", ROOT), false);
check("projectX is NOT inside project", isPathInside("C:\\Users\\me\\projectX\\a.js", ROOT), false);
check("project.bak is NOT inside project", isPathInside("C:\\Users\\me\\project.bak\\a.js", ROOT), false);

section("Traversal and unrelated paths");
check("dot-dot escape", isPathInside(`${ROOT}\\..\\other\\a.js`, ROOT), false);
check("dot-dot to a prefix sibling", isPathInside(`${ROOT}\\..\\project-secrets\\loot.txt`, ROOT), false);
check("an unrelated absolute path", isPathInside("C:\\Windows\\win.ini", ROOT), false);
check("the parent directory", isPathInside("C:\\Users\\me", ROOT), false);

section("Case insensitivity, since Windows paths are");
check("different case is still inside", isPathInside(`${ROOT.toUpperCase()}\\APP.JS`, ROOT), true);
check("sameResolvedPath ignores case", sameResolvedPath(ROOT, ROOT.toUpperCase()), true);

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
