/**
 * A deliberately tiny assertion harness.
 *
 * No test framework, because adding one would mean a dependency, a config file
 * and a watch mode for a suite that is six files of plain assertions. These run
 * against the COMPILED output in dist-electron, which means they exercise what
 * actually ships rather than what TypeScript hoped for.
 *
 * They are also entirely OFFLINE. Nothing here touches a provider, a network,
 * or an API key. `npm test` costs nothing to run, which is the only reasonable
 * property for a suite you want people to run constantly.
 */

let passed = 0;
let failed = 0;
const failures = [];

export function section(title) {
  console.log(`\n  ${title}`);
}

export function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  record(ok, label, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

export function ok(label, value) {
  record(value === true, label, `expected true, got ${JSON.stringify(value)}`);
}

function record(isOk, label, detail) {
  if (isOk) {
    passed += 1;
    console.log(`    PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}: ${detail}`);
    console.log(`    FAIL  ${label}  ${detail}`);
  }
}

export function summary() {
  return { passed, failed, failures };
}

/** Resolves a module from the build output. Fails with a useful message rather
 *  than a module-not-found stack when someone runs the tests before building. */
export async function fromBuild(relativePath) {
  const { pathToFileURL } = await import("node:url");
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const abs = resolve(process.cwd(), "dist-electron", relativePath);
  if (!existsSync(abs)) {
    console.error(`\nCannot find ${relativePath} in dist-electron.\nRun "npm run build" first: these tests exercise the compiled output on purpose.\n`);
    process.exit(2);
  }
  return import(pathToFileURL(abs).href);
}
