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
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { section, check, ok, summary } from "../harness.mjs";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");
const README = read("README.md");
const docFiles = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md"));

/** Every main-process source joined. Carves keep moving code between files in
 *  src/electron (docs/STRUCTURAL_DEBT.md item 1), and every assertion here is
 *  about what the main process DOES rather than about which file it is in. */
const electronSources = () =>
  readdirSync(join(root, "src", "electron"))
    .filter((file) => file.endsWith(".ts") || file.endsWith(".cts"))
    .map((file) => readFileSync(join(root, "src", "electron", file), "utf8"))
    .join("\n");

section("A doc cannot claim both that tests exist and that they do not");
{
  // The README said "there are no tests" twenty lines above "an offline test
  // suite (npm test, 28 suites)". Both sentences were written honestly, years
  // apart in project time, and the count guard below could not see it because
  // the count it pins was in the sentence that was RIGHT. A number being
  // correct says nothing about the prose around it disagreeing with itself.
  const suites = readdirSync(join(root, "tests", "suites")).filter((f) => f.endsWith(".mjs")).length;
  // Narrow on purpose. A first pass also matched /untested/, which fired on
  // "untested against real willingness-to-pay" in the business plan and on the
  // roadmap's accurate note that the renderer has no machine tests of its own —
  // neither is a denial that the suites exist. A guard that cries wolf on true
  // sentences gets the whole section deleted.
  const denials = [/there are no tests/i, /no test suite/i];
  for (const [name, text] of [["README.md", README], ...docFiles.map((f) => [`docs/${f}`, read(join("docs", f))])]) {
    for (const pattern of denials) {
      ok(`${name} does not deny the ${suites} suites it ships`, !(suites > 0 && pattern.test(text)));
    }
  }
}

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
  const mainSource = electronSources();
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

section("The changelog is shaped the way it says it is");
{
  const changelog = read("CHANGELOG.md");
  const headings = [...changelog.matchAll(/^### ([A-Z][a-z]+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/gm)];
  ok("it has dated sections at all", headings.some((h) => h[2]));

  // Keep a Changelog's vocabulary. A seventh kind invented in passing means a
  // reader cannot skim for "Fixed" and trust they saw every fix.
  const kinds = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);
  check("only standard section kinds are used", [...new Set(headings.map((h) => h[1]))].filter((k) => !kinds.has(k)), []);

  // Real dates, not 2026-13-45 or a typo'd year.
  const dated = headings.filter((h) => h[2]);
  const invalid = dated.map((h) => h[2]).filter((d) => {
    const parsed = new Date(`${d}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d;
  });
  check("every section date is a real calendar date", invalid, []);

  // Newest first, the order the file already uses. Caught its first real defect
  // immediately: a section added on the 26th was filed below one from the 25th.
  const order = dated.map((h) => h[2]);
  const misordered = order.filter((d, i) => i > 0 && d > order[i - 1]);
  check("dated sections read newest-first", misordered, []);

  // One heading per kind per date, or an entry can land in either of two
  // identical-looking sections and only one gets read.
  const seen = new Set();
  const duplicated = [];
  for (const [, kind, date] of dated) {
    const key = `${kind} ${date}`;
    if (seen.has(key)) duplicated.push(key);
    seen.add(key);
  }
  check("no date has the same section kind twice", duplicated, []);
  ok("an Unreleased section exists to add to", changelog.includes("## [Unreleased]"));
}

section("A shipped version has somewhere to read about it");
{
  // Written after v1.1.0 was found tagged, released and entirely undocumented:
  // the changelog jumped from Unreleased to 1.0.0, so 129 commits of work sat
  // under a heading saying it had not shipped, and the installer that release
  // built had no notes at all. The commit that fixed it claimed no mechanical
  // check could have caught this. That was wrong, and this is the check.
  //
  // Only the NEWEST tag is required, not every tag. v0.1.0 and v0.2.0 are
  // pre-1.0 development tags with no entries by choice, and demanding notes for
  // them retroactively would be inventing history rather than recording it.
  const documented = new Set([...read("CHANGELOG.md").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]));
  ok(`the changelog documents ${documented.size} releases`, documented.size > 0);

  const version = JSON.parse(read("package.json")).version;
  ok(`package.json version ${version} has a changelog section`, documented.has(version));

  let newestTag = null;
  try {
    newestTag = execFileSync("git", ["tag", "--sort=-v:refname"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((t) => t.trim()).filter(Boolean)[0] ?? null;
  } catch {
    newestTag = null;
  }
  if (!newestTag) {
    ok("newest tag not checked (no tags fetched here)", true);
  } else {
    ok(`newest tag ${newestTag} has a changelog section`, documented.has(newestTag.replace(/^v/, "")));
  }
}

section("The changelog has not fallen behind the code");
{
  // "All notable changes to Metis Orchestrator are documented in this file" is
  // the strongest claim any doc here makes, and the only one that decays purely
  // by shipping. This measures it: how many commits have touched src/ since
  // CHANGELOG.md was last touched.
  //
  // The threshold is taken from this repo rather than invented. Across every
  // changelog update in its history the largest gap was 7 src commits, so 8 is
  // the first number that has never legitimately occurred. A normal working
  // stretch passes; a release's worth of unrecorded change does not.
  //
  // Degrades rather than lies: a shallow clone has no history to measure, so
  // the check reports that it could not run instead of passing quietly. CI
  // fetches full history specifically so it does run there.
  const MAX_LAG = 7;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let lag = null;
  let why = "";
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") {
      why = "shallow clone, no history to measure";
    } else {
      const last = git("log", "-1", "--format=%H", "--", "CHANGELOG.md");
      if (!last) why = "CHANGELOG.md has no commit history";
      else lag = Number(git("rev-list", "--count", `${last}..HEAD`, "--", "src"));
    }
  } catch {
    why = "git is not available here";
  }
  if (lag === null) {
    ok(`changelog lag not measured (${why})`, true);
    console.log(`      note: this check is a no-op in this environment, by design rather than by accident`);
  } else {
    ok(`${lag} src commits since CHANGELOG.md last changed (limit ${MAX_LAG})`, lag <= MAX_LAG);
  }
}

section("The /loop hint is inside the input, not stacked above it");
{
  // A claim FEATURES.md and the changelog both make, and one nothing else can
  // check: the offline suites have no DOM, and the browser preview cannot reach
  // the composer because navigation is gated behind the benchmark wizard.
  //
  // So the invariant is enforced on the source, the same way 14 enforces the
  // conversation lock. It came from real use — "the recommendations for when
  // you're using /loop or whatever should be inside the prompt box not above
  // it" — and it is exactly the kind of thing a later refactor moves back out
  // by accident, because a sibling above the textarea is where a hint reads as
  // natural to write.
  const app = read("src/renderer/ui/App.tsx");
  const wrap = app.indexOf('className={loopCommand.isLoopCommand ? "composer-input-wrap has-loop-hint"');
  const hint = app.indexOf('<div className="composer-loop-hint"');
  const textarea = app.indexOf("<textarea", wrap);
  ok("the input wrap flags the hint", wrap !== -1);
  ok("the hint renders after the wrap opens", hint > wrap);
  ok("and after the textarea, so it sits below what you type", hint > textarea);

  const css = read("src/renderer/styles.css");
  const ruleStart = css.indexOf(".composer-loop-hint {");
  const rule = css.slice(ruleStart, css.indexOf("}", ruleStart));
  ok("it is positioned inside the input", /position:\s*absolute/.test(rule) && /bottom:\s*0/.test(rule));
  // A fill and a full border are what made it read as a separate banner
  // sitting on the composer rather than as the input annotating itself. A
  // hairline `border-top` is allowed and is the whole separation it gets.
  ok("with no fill and no full border of its own", !/^\s*(background|border):/m.test(rule));
  // Clicks belong to the textarea underneath — it is annotation, not a control.
  ok("and it does not swallow clicks", /pointer-events:\s*none/.test(rule));
  ok("the textarea is padded to clear it", /\.composer-input-wrap\.has-loop-hint textarea\s*\{[^}]*padding-bottom/.test(css));
}

section("Every store key main reads has a control that can change it");
{
  // The standing complaint this guards: logic shipped with no screen to reach
  // it. Three keys were read by main.ts from the day each shipped and had no
  // control anywhere — knowledgeBankEnabled for its whole life, the other two
  // for a few hours. A key main reads and the renderer cannot write is a
  // setting only a text editor can change.
  //
  // Deliberately a short explicit list, not a scan for every readStoreValue
  // call: plenty of keys are genuinely internal (lastProjectSnapshot,
  // usageLedger), and a check that flags those is one somebody deletes.
  const app = read("src/renderer/ui/App.tsx");
  for (const key of ["knowledgeBankEnabled", "retrievalPosture", "thinkTokenCeiling"]) {
    // Tolerant of the type parameter and of the call being wrapped across
    // lines — this is checking that the renderer binds the key at all, not how
    // prettier felt about it that day.
    ok(`${key} is reachable from Settings`, new RegExp(`useAppStoreState(?:<[^>]+>)?\\(\\s*"${key}"`).test(app));
  }
  // A control is not reachable if nothing renders it.
  ok("the knowledge-bank toggle renders", /setKnowledgeBankEnabled\(!knowledgeBankEnabled\)/.test(app));
  ok("the posture select renders", /setRetrievalPosture\(event\.target\.value as RetrievalOverride\)/.test(app));
  ok("the think-budget field renders", /setThinkTokenCeiling\(/.test(app));
  // Opening Settings for the first time must not change how the app behaves,
  // so every default has to match what main.ts already assumed.
  const main = electronSources();
  ok("the bank default still matches main", /readStoreValue<boolean>\("knowledgeBankEnabled", true\)/.test(main) && app.includes('useAppStoreState("knowledgeBankEnabled", true)'));
  ok("the ceiling default still matches main", /readStoreValue<number>\("thinkTokenCeiling", DEFAULT_THINK_TOKEN_CEILING\)/.test(main) && app.includes("DEFAULT_THINK_TOKEN_CEILING)"));
  ok("the posture default still matches main", /readStoreValue<RetrievalOverride>\("retrievalPosture", RETRIEVAL_OVERRIDE_DEFAULT\)/.test(main));
}

section("A panel in a hidden settings section is not a surface");
{
  // Written because the previous reachability guard was not enough and I
  // proved it. On 2026-08-16 the rung ledger shipped with a source check that
  // it RENDERS, which passed — while sitting in Settings > Usage, a section
  // v1 deliberately hides. The changelog and FEATURES both said "Settings >
  // Usage adds a table" as though you could open it. Rendering is not
  // reaching, and a guard that only proves the JSX exists checks the wrong
  // layer.
  const app = read("src/renderer/ui/App.tsx");
  const hidden = new Set(
    (/const V1_HIDDEN_SETTINGS = new Set<SettingsSection>\(\[([^\]]*)\]\)/.exec(app)?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
  );
  ok("the hidden set was found", hidden.size > 0);

  /** Which `section === "x"` block a heading sits inside. */
  const sectionOf = (heading) => {
    const at = app.indexOf(heading);
    if (at < 0) return null;
    const before = app.slice(0, at);
    const marks = [...before.matchAll(/\{section === "(\w+)" \? \(/g)];
    return marks.length ? marks[marks.length - 1][1] : null;
  };

  // Expected visibility per panel, so drift in EITHER direction fails: a panel
  // moving into a hidden section, or a section being unhidden without the
  // docs catching up.
  const panels = [
    { heading: "What each rung served", reachable: false },
    { heading: "What Metis is noticing", reachable: false },
    { heading: "How much of your project reaches the model", reachable: true }
  ];
  for (const panel of panels) {
    const where = sectionOf(panel.heading);
    ok(`"${panel.heading}" is in a section`, Boolean(where));
    const isReachable = where !== null && !hidden.has(where);
    check(`"${panel.heading}" reachability (section: ${where})`, isReachable, panel.reachable);
  }

  // The rung BADGE is the reachable half of that feature — it renders on every
  // run's route line in the chat feed, which is not a settings section at all.
  // Worth pinning separately so "the rung ledger is unreachable" never becomes
  // "nothing about rungs is visible".
  ok("the per-message rung badge is outside settings entirely", sectionOf("function RungBadge(") === null);

  // And the docs must say so rather than implying an openable panel. Matched
  // loosely on purpose — the point is that the changelog says Usage is hidden
  // somewhere near where it says Usage gains a panel, not that it says it in
  // one blessed phrasing.
  const changelog = read("CHANGELOG.md");
  ok("the changelog flags the hidden section", /Usage[\s\S]{0,200}?\bhid(?:den|es)\b/i.test(changelog));
  // LIMITATIONS is where a reader goes to find out what does not work, so the
  // whole section being unopenable belongs there rather than only in a
  // per-feature note.
  ok("LIMITATIONS records the whole section as hidden", /Settings > Usage is hidden in v1/.test(read("docs/LIMITATIONS.md")));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
