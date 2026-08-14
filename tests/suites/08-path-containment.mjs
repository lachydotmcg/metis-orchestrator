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

const { isPathInside, sameResolvedPath, isGeneratedImagePath, isAppNavigationUrl, isLoopbackHttpUrl, isRegistryFetchUrl } = await fromBuild("shared/intent-and-paths.js");

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

section("Only Metis's own generated images may be painted in the chat");
{
  // The renderer asks main for image bytes by absolute path. This is the rule
  // that decides which paths are answerable, and it exists SEPARATELY from the
  // document viewer's guard on purpose: generated images land outside any
  // workspace when no project folder is selected, so reusing that guard would
  // have meant widening it to cover userData.
  const userDataImagesDir = join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Metis', 'metis-store', 'generated-projects', 'images');
  const workspaceImagesDir = join('C:', 'work', 'site', 'images');
  const dirs = { userDataImagesDir, workspaceImagesDir };

  check('a userData generated image is allowed', isGeneratedImagePath(join(userDataImagesDir, 'metis-image-1.png'), dirs), true);
  check('a workspace generated image is allowed', isGeneratedImagePath(join(workspaceImagesDir, 'metis-image-2.png'), dirs), true);

  // The refusals are the point of the guard.
  check('a source file in the same workspace is refused', isGeneratedImagePath(join('C:', 'work', 'site', 'script.js'), dirs), false);
  check('a key file is refused', isGeneratedImagePath(join('C:', 'work', 'site', '.env'), dirs), false);
  check('the store itself is refused', isGeneratedImagePath(join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Metis', 'metis-store', 'secrets.json'), dirs), false);
  check('an arbitrary absolute path is refused', isGeneratedImagePath(join('C:', 'Windows', 'System32', 'config', 'SAM'), dirs), false);
  check('empty input is refused', isGeneratedImagePath('', dirs), false);

  // Same prefix-attack property the rest of this suite exists for: a sibling
  // folder whose name merely starts with 'images' is not inside it.
  check('a prefix-sharing sibling is refused', isGeneratedImagePath(join('C:', 'work', 'site', 'images-backup', 'x.png'), dirs), false);

  // Traversal out of an allowed folder must not survive resolution.
  check('traversal out of the allowed folder is refused', isGeneratedImagePath(join(workspaceImagesDir, '..', 'script.js'), dirs), false);

  // With no project folder selected there is no workspace half at all, and the
  // userData half must still work on its own.
  const noWorkspace = { userDataImagesDir };
  check('userData still works with no workspace', isGeneratedImagePath(join(userDataImagesDir, 'a.png'), noWorkspace), true);
  check('a workspace path is refused when no workspace is selected', isGeneratedImagePath(join(workspaceImagesDir, 'a.png'), noWorkspace), false);
}


section("Navigation guards: only the app itself may drive the top-level window");
{
  const dev = "http://127.0.0.1:5177";
  check("the packaged renderer", isAppNavigationUrl("file:///C:/app/dist/index.html", undefined), true);
  check("the dev server", isAppNavigationUrl("http://127.0.0.1:5177/index.html", dev), true);
  check("a different port on the same host is NOT the app", isAppNavigationUrl("http://127.0.0.1:9999/", dev), false);
  check("an outside site", isAppNavigationUrl("https://evil.example/", dev), false);
  check("the dev server when none is configured", isAppNavigationUrl("http://127.0.0.1:5177/", undefined), false);
  check("garbage", isAppNavigationUrl("not a url", dev), false);
  check("empty", isAppNavigationUrl("", dev), false);
}

section("Subframes may reach the loopback preview server, and nothing else");
{
  check("the preview server on an ephemeral port", isLoopbackHttpUrl("http://127.0.0.1:52341/index.html"), true);
  check("localhost", isLoopbackHttpUrl("http://localhost:8080/"), true);
  // The prefix attack this whole suite exists for, in hostname form: a domain
  // that merely STARTS with the loopback address is not loopback.
  check("a lookalike hostname is refused", isLoopbackHttpUrl("http://127.0.0.1.evil.example/"), false);
  check("a subdomain lookalike is refused", isLoopbackHttpUrl("http://localhost.evil.example/"), false);
  check("a public host", isLoopbackHttpUrl("https://example.com/"), false);
  check("a file url", isLoopbackHttpUrl("file:///C:/x.html"), false);
  check("a data url", isLoopbackHttpUrl("data:text/html,hi"), false);
  check("empty", isLoopbackHttpUrl(""), false);
}


section("Registry fetches are allowlisted, and happen in main");
{
  // The Marketplace used to fetch package source_url values straight from the
  // renderer, which meant it could reach any host a registry entry named. That
  // also made a useful connect-src impossible, so the CSP was unbuildable
  // while it stood.
  check("github api", isRegistryFetchUrl("https://api.github.com/repos/a/b"), true);
  check("raw content", isRegistryFetchUrl("https://raw.githubusercontent.com/a/b/main/x.json"), true);
  check("github itself", isRegistryFetchUrl("https://github.com/a/b"), true);

  // The refusals are the point.
  check("an arbitrary host", isRegistryFetchUrl("https://evil.example/payload.json"), false);
  // Same prefix-attack shape as the rest of this suite, at hostname level.
  check("a lookalike host", isRegistryFetchUrl("https://api.github.com.evil.example/x"), false);
  check("a subdomain of an allowed host", isRegistryFetchUrl("https://evil.api.github.com/x"), false);
  // http is refused outright: a registry entry naming one is a mistake or a
  // downgrade attempt.
  check("plain http is refused", isRegistryFetchUrl("http://api.github.com/repos/a/b"), false);
  check("a file url", isRegistryFetchUrl("file:///C:/x.json"), false);
  check("a data url", isRegistryFetchUrl("data:application/json,{}"), false);
  check("loopback is not a registry host", isRegistryFetchUrl("http://127.0.0.1:8080/x"), false);
  check("empty", isRegistryFetchUrl(""), false);
  check("garbage", isRegistryFetchUrl("not a url"), false);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
