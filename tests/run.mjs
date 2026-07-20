/**
 * Runs every suite in tests/suites, in its own process, and exits non-zero if
 * any assertion failed.
 *
 * Separate processes on purpose: a suite that crashes or leaves global state
 * behind cannot take the others with it, and the exit code of each is an
 * unambiguous pass/fail signal.
 */

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suiteDir = join(here, "suites");
const suites = readdirSync(suiteDir).filter((f) => f.endsWith(".mjs")).sort();

const only = process.argv[2];
const selected = only ? suites.filter((s) => s.includes(only)) : suites;

if (!selected.length) {
  console.error(only ? `No suite matches "${only}". Available: ${suites.join(", ")}` : "No suites found.");
  process.exit(2);
}

const runOne = (file) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [join(suiteDir, file)], {
      cwd: resolve(here, ".."),
      stdio: "inherit"
    });
    child.on("close", (code) => done({ file, code: code ?? 1 }));
  });

console.log(`Running ${selected.length} suite${selected.length === 1 ? "" : "s"} against dist-electron.`);
console.log("These are offline: no provider is called and no API key is read.\n");

const results = [];
for (const file of selected) {
  results.push(await runOne(file));
}

const failedSuites = results.filter((r) => r.code !== 0);
console.log("\n" + "=".repeat(60));
for (const r of results) {
  console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${r.file}`);
}
console.log("=".repeat(60));

if (failedSuites.length) {
  console.error(`\n${failedSuites.length} of ${results.length} suites failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} suites passed.`);
