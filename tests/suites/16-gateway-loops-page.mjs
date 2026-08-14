// The phone page the gateway serves. Imports the REAL generator from the build.
//
// What this exists to prevent: the page carries the gateway bearer token, and
// the token is interpolated into a <script> block. Concatenating it would make
// the token an injection point into a page that then makes authenticated calls
// — the worst possible place for one. It is injected via JSON.stringify, and
// these tests hold that line.
//
// The page is also the first surface in this app that renders loop goals
// OUTSIDE the React renderer, where JSX escaping is doing the work for free.
// Here nothing escapes anything, so the page builds every node with
// textContent and never innerHTML, and that is asserted below too.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { gatewayLoopsPage } = await fromBuild("electron/gateway-loops-page.js");

const REAL_TOKEN = "a3f9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4";

section("It produces a real page");
{
  const page = gatewayLoopsPage(REAL_TOKEN);
  ok("it is a full document", page.trimStart().startsWith("<!doctype html>"));
  ok("it declares a mobile viewport", page.includes("width=device-width"));
  ok("it carries the token", page.includes(REAL_TOKEN));
  ok("it calls the loops route", page.includes("/v1/loops"));
  ok("it sends the token as a bearer header", page.includes('"Bearer " + token'));
}

section("The token cannot break out of the script literal");
{
  // Each of these ends the string, the script, or the document if the token is
  // concatenated rather than encoded.
  const attacks = [
    '";alert(1);var x="',
    "';alert(1);var x='",
    '</script><script>alert(1)</script>',
    '</SCRIPT ><img src=x onerror=alert(1)>',
    'a\\";alert(1);//',
    ' alert(1) ',
    '`;alert(1);`'
  ];
  for (const attack of attacks) {
    const page = gatewayLoopsPage(attack);
    // The decisive assertion: the raw payload must never appear verbatim.
    // JSON.stringify escapes the quotes and slashes that make these work.
    ok(`no verbatim breakout for ${JSON.stringify(attack).slice(0, 34)}`, !page.includes(`= ${attack};`));
    ok(`no injected closing script tag for ${JSON.stringify(attack).slice(0, 24)}`, !/<\/script\s*>\s*<script/i.test(page));
  }
}

section("A token with a quote still round-trips as itself");
{
  // Escaping that mangles the token would be a different bug: the page would
  // load and every request would 401.
  const quoted = 'tok"en';
  const page = gatewayLoopsPage(quoted);
  ok("it is present in escaped form", page.includes(JSON.stringify(quoted)));
  ok("and not in raw form", !page.includes('= tok"en;'));
}

section("Loop text is never written as markup");
{
  const page = gatewayLoopsPage(REAL_TOKEN);
  // A goal is user-authored and a history summary is MODEL-authored — the
  // second is the one that matters, since it is the only untrusted string on
  // this page. Both go through textContent.
  ok("goals use textContent", page.includes("goal.textContent"));
  ok("summaries use textContent", page.includes("summary.textContent"));
  ok("nothing uses innerHTML", !page.includes("innerHTML"));
  ok("nothing uses insertAdjacentHTML", !page.includes("insertAdjacentHTML"));
  ok("nothing uses document.write", !page.includes("document.write"));
}

section("It behaves itself on a phone");
{
  const page = gatewayLoopsPage(REAL_TOKEN);
  ok("it stops polling when hidden", page.includes("document.hidden"));
  ok("it refreshes on becoming visible", page.includes("visibilitychange"));
  ok("it clears its timer on pagehide", page.includes("pagehide"));
  ok("the destructive control confirms first", page.includes("window.confirm"));
  ok("the token is stripped from the address bar", page.includes("history.replaceState"));
  ok("loop ids are encoded into the stop URL", page.includes("encodeURIComponent(loop.id)"));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
