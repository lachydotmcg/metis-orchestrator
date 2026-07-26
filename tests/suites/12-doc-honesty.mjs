// The docs are a claim about the code, and this suite makes it a checkable one.
//
// Metis's README stakes its credibility on a marker table: VERIFIED has a
// recorded run behind it, SHIPPED works when driven by hand, FLAG OFF is built
// but defaults to off, PLANNED is designed and not built. That promise is the
// product's argument for itself — an app whose whole pitch is "you can see what
// the router decided" cannot be vague about what it has actually built.
//
// Kept by hand, the promise decays in one direction. Prose describing a gap
// outlives the gap, because shipping the feature is the interesting part and
// deleting the sentence about its absence is not. In a single day this repo
// shipped loop budgets, tray listing and phase 2A helpers, and then had to be
// corrected three separate times: the README still listed a shipped feature
// under "Designed, not built yet", LIMITATIONS.md still said "No token
// ceiling", and FEATURES.md still said "there is no spawning of parallel
// workers". Every one of those was true when written.
//
// So the checks below are all one shape: a claim in prose, compared against
// the thing it claims about. Nothing here judges whether a feature is GOOD —
// only whether the sentence describing it is still true.
//
// Offline: reads files, calls no provider, needs no API key, and does not even
// need a build.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { section, check, ok, summary } from "../harness.mjs";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");
const README = read("README.md");
const docFiles = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"));

section("A claimed suite count is a number that can simply be wrong");
{
  // The bug: the README said "8 suites" while ten existed. Nobody was lying;
  // the number was written once and suites kept arriving.
  const actual = readdirSync(join(root, "tests", "suites")).filter((f) => f.endsWith(".mjs")).length;
  const claims = [["README.md", README], ...docFiles.map((f) => [`docs/${f}`, read(join("docs", f))])];
  for (const [name, text] of claims) {
    for (const [, claimed] of text.matchAll(/(\d+)\s+suites/g)) {
      check(`${name} says ${claimed} suites`, Number(claimed), actual);
    }
  }
}

section("Every doc link points at a file that exists");
{
  // A dead link is the cheapest possible broken promise: the doc says "the
  // honest limits are in X" and X is gone.
  const targets = [["README.md", README], ...docFiles.map((f) => [`docs/${f}`, read(join("docs", f))])];
  let checked = 0;
  let dead = [];
  for (const [name, text] of targets) {
    const from = dirname(join(root, name));
    for (const [, href] of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      checked += 1;
      if (!existsSync(resolve(from, href))) dead.push(`${name} -> ${href}`);
    }
  }
  ok(`${checked} internal doc links resolve`, dead.length === 0);
  if (dead.length) console.log(`      dead: ${dead.join(", ")}`);
}

section("The marker vocabulary is closed");
{
  // Four markers are defined in the README's own "What it does" preamble. A
  // fifth invented in passing means a reader has to guess how real it is,
  // which defeats the point of having markers.
  const allowed = new Set(["VERIFIED", "SHIPPED", "FLAG OFF", "PLANNED"]);
  const used = new Set();
  for (const [, marker] of README.matchAll(/`([A-Z][A-Z ]{2,})`/g)) used.add(marker);
  const strays = [...used].filter((m) => !allowed.has(m));
  ok(`only the four documented markers appear (found: ${[...used].sort().join(", ")})`, strays.length === 0);
}

section('"Designed, not built yet" cannot contain something already built');
{
  // The exact bug from 2026-07-25: Flowchart Loops shipped in the morning and
  // stayed in the not-built-yet table, marked SHIPPED, contradicting the
  // heading it sat under.
  const start = README.indexOf("**Designed, not built yet:**");
  ok("the not-built-yet section exists", start !== -1);
  if (start !== -1) {
    const rest = README.slice(start + 1);
    const end = rest.indexOf("\n\n---");
    const body = end === -1 ? rest : rest.slice(0, end);
    for (const built of ["VERIFIED", "SHIPPED", "FLAG OFF"]) {
      ok(`nothing under it is marked ${built}`, !body.includes(`\`${built}\``));
    }
    ok("and it does mark things PLANNED", body.includes("`PLANNED`"));
  }
}

section("FLAG OFF means a real flag that really defaults to off");
{
  // The strongest claim the README makes about this group: "all default to
  // off", and "their off-state is byte-identical to the code path that existed
  // before the feature was built". The first half is checkable here.
  //
  // The mapping is written down rather than inferred, because the README names
  // features in English and the code names store keys. Keeping it explicit
  // means adding a FLAG OFF row without wiring it fails loudly.
  const mapping = {
    Oracle: ["prewarmEnabled", "oracleCloudEnabled"],
    Depths: ["depthRoutingEnabled"],
    "Agentic tools": ["agentToolsEnabled"],
    "Metis Gateway": ["gatewayEnabled"],
    "MCP, both directions": ["mcpToolsEnabled"],
    "Multi-agent fan-out": ["fanoutEnabled"],
    "Model-driven routing": ["modelDrivenRoutingEnabled"],
    "Quick-ask and headless start": ["quickAskEnabled", "headlessStart"]
  };

  const named = [...README.matchAll(/\*\*([^*]+)\*\* `FLAG OFF`/g)].map((m) => m[1]);
  check("every FLAG OFF feature in the README is mapped to its store keys", named.filter((n) => !mapping[n]), []);
  check("and the mapping has no entries the README dropped", Object.keys(mapping).filter((k) => !named.includes(k)), []);

  // Ground truth 1: doctor's declared defaults.
  const cliSource = read("src/electron/cli.ts");
  const declared = new Map();
  for (const [, key, def] of cliSource.matchAll(/\{\s*key:\s*"(\w+)",\s*label:\s*"[^"]*",\s*default:\s*(true|false)\s*\}/g)) {
    declared.set(key, def === "true");
  }
  ok(`doctor declares defaults for ${declared.size} flags`, declared.size > 0);

  // Ground truth 2: what the code actually falls back to when the key is unset.
  const mainSource = read("src/electron/main.ts");
  const actual = new Map();
  for (const [, key, def] of mainSource.matchAll(/readStoreValue<boolean>\("(\w+)",\s*(true|false)\)/g)) {
    actual.set(key, def === "true");
  }
  ok(`main.ts reads ${actual.size} boolean flags`, actual.size > 0);

  for (const [feature, keys] of Object.entries(mapping)) {
    for (const key of keys) {
      const known = declared.has(key) || actual.has(key);
      ok(`${feature}: "${key}" exists in the code`, known);
      if (declared.has(key)) ok(`${feature}: doctor declares "${key}" off`, declared.get(key) === false);
      if (actual.has(key)) ok(`${feature}: "${key}" falls back to off`, actual.get(key) === false);
    }
  }

  // The two ground truths must not disagree with each other. doctor exists so
  // a user can ask what is on without opening Settings; a doctor that reports
  // a default the app does not use is worse than no doctor.
  const disagreed = [...actual.keys()].filter((k) => declared.has(k) && declared.get(k) !== actual.get(k));
  check("doctor's declared defaults match the real fallbacks", disagreed, []);

  // And doctor must not be silently missing a flag that gates real capability.
  const missing = [...actual.keys()].filter((k) => !declared.has(k));
  check("every boolean flag main.ts reads is reported by doctor", missing, []);
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
