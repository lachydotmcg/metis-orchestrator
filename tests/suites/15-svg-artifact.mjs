// Which ```svg blocks get DRAWN instead of printed. Imports the real gate from
// the build.
//
// Why a gate at all: Metis routes to whatever model is available, including
// small local ones, and a 7B model emits unclosed tags, stray backticks and
// half-finished markup constantly. A broken render is worse than no render, so
// anything that does not pass falls back to an ordinary code block. That makes
// the FALSE cases the important half of this suite — a gate that only proves it
// says yes to good input has not been tested.
//
// Note what is deliberately absent: nothing here asserts that <script> is
// stripped, because nothing strips it. The renderer draws through
// <img src="data:image/svg+xml;base64,…">, and an SVG loaded via <img> runs in
// secure static mode — no scripts, no external fetches, no interactivity. That
// is a browser guarantee, and writing a sanitiser would imply it needs one.
// The test below asserts the guarantee is RELIED ON, not re-implemented.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { isRenderableSvg, svgDataUrl, SVG_ARTIFACT_MAX_CHARS, fenceMayBeSvg } = await fromBuild("shared/svg-artifact.js");

const CHART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="80" height="40" fill="teal"/></svg>';

section("A complete SVG document is drawable");
ok("a plain chart", isRenderableSvg(CHART));
ok("leading and trailing whitespace is fine", isRenderableSvg(`\n\n  ${CHART}  \n`));
ok("an XML declaration is fine", isRenderableSvg(`<?xml version="1.0" encoding="UTF-8"?>\n${CHART}`));
ok("a doctype is fine", isRenderableSvg(`<!DOCTYPE svg>\n${CHART}`));
ok("a leading comment is fine", isRenderableSvg(`<!-- generated -->\n${CHART}`));
ok("a trailing comment is fine", isRenderableSvg(`${CHART}\n<!-- end -->`));
ok("newlines inside the root tag are fine", isRenderableSvg('<svg\n  xmlns="http://www.w3.org/2000/svg"\n  viewBox="0 0 10 10">\n<rect/>\n</svg>'));
ok("nested svg balances", isRenderableSvg('<svg viewBox="0 0 10 10"><svg viewBox="0 0 5 5"><rect/></svg></svg>'));

section("Truncated output from a small model is NOT drawn");
ok("no closing tag", !isRenderableSvg('<svg viewBox="0 0 10 10"><rect/>'));
ok("cut off mid-attribute", !isRenderableSvg('<svg viewBox="0 0 10'));
ok("cut off mid-tag", !isRenderableSvg('<svg viewBox="0 0 10 10"><re'));
ok("closing tag only", !isRenderableSvg("</svg>"));
ok("two opens, one close", !isRenderableSvg('<svg><svg><rect/></svg>'));

section("Anything that is not a single root SVG is NOT drawn");
ok("empty string", !isRenderableSvg(""));
ok("whitespace only", !isRenderableSvg("   \n  "));
ok("prose", !isRenderableSvg("Here is a chart for you."));
ok("prose before the root", !isRenderableSvg(`Here you go: ${CHART}`));
// The one that matters most: without a tail check, this draws the chart and
// silently swallows the model's explanation.
ok("prose after the root", !isRenderableSvg(`${CHART} and that is how it works`));
ok("two sibling documents", !isRenderableSvg(`${CHART}${CHART}`));
ok("an HTML document that merely contains an svg", !isRenderableSvg(`<html><body>${CHART}</body></html>`));
ok("a tag that merely starts with svg", !isRenderableSvg("<svgfoo></svgfoo>"));
ok("non-string input", !isRenderableSvg(undefined));
ok("a number", !isRenderableSvg(42));

section("Size is bounded");
{
  const filler = "<rect/>".repeat(200);
  ok("a large but sane chart still draws", isRenderableSvg(`<svg viewBox="0 0 10 10">${filler}</svg>`));
  const huge = `<svg viewBox="0 0 10 10">${"<rect/>".repeat(SVG_ARTIFACT_MAX_CHARS)}</svg>`;
  ok("an oversized document does not", !isRenderableSvg(huge));
}

section("The data URL is only ever produced for drawable input");
{
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  const url = svgDataUrl(CHART, encode);
  ok("it is a base64 svg data URL", url.startsWith("data:image/svg+xml;base64,"));
  check("it round-trips to the original markup", Buffer.from(url.split(",")[1], "base64").toString("utf8"), CHART);
  // A caller that forgets to gate still cannot render junk.
  check("truncated input yields no URL", svgDataUrl("<svg><rect/>", encode), "");
  check("prose yields no URL", svgDataUrl("hello", encode), "");
}

section("Script is NOT stripped, because <img> is the boundary");
{
  // If this ever starts returning false, someone has added a sanitiser — and
  // the moment a sanitiser exists, people start trusting IT instead of the
  // <img> boundary that actually provides the guarantee. An SVG loaded via
  // <img> cannot execute script regardless of what this markup contains.
  const withScript = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
  ok("markup containing a script tag is still structurally valid", isRenderableSvg(withScript));
  const encode = (value) => Buffer.from(value, "utf8").toString("base64");
  ok("and it is passed through unmodified", Buffer.from(svgDataUrl(withScript, encode).split(",")[1], "base64").toString("utf8") === withScript);
}


section("The fence LABEL must not decide whether an SVG renders");
{
  // The v1.2.0 bug, reproduced. Qwen3 8B answered a chart request with this
  // exact shape: correct, complete SVG inside an xml fence. The old code
  // tested for the label "svg" and nothing else, so it printed as code.
  const QWEN_REPLY = '<svg width="300" height="200" xmlns="http://www.w3.org/2000/svg"><rect x="50" y="133" width="30" height="66" fill="blue"/></svg>';
  ok("the markup itself was always fine", isRenderableSvg(QWEN_REPLY));
  ok("an xml fence is now looked under", fenceMayBeSvg("xml"));
  ok("and so is svg", fenceMayBeSvg("svg"));
  ok("and html", fenceMayBeSvg("html"));
  // A bare fence is common from small models and must not be skipped.
  ok("a bare fence is looked under", fenceMayBeSvg(""));
  ok("case and whitespace do not matter", fenceMayBeSvg("  XML "));
}

section("But an unrelated label is still skipped without parsing");
{
  // Keeps the cost of a wrong guess at zero: these never reach isRenderableSvg.
  for (const lang of ["js", "ts", "python", "json", "bash", "css", "metis-loop", "metis-actions"]) {
    ok(`${lang} is not looked under`, !fenceMayBeSvg(lang));
  }
  ok("non-string input", !fenceMayBeSvg(undefined));
}

section("Content still decides, so a wrong label cannot force a render");
{
  // fenceMayBeSvg only says "worth looking". An xml fence holding actual XML
  // must still print as code.
  ok("an xml fence is looked under", fenceMayBeSvg("xml"));
  ok("but real XML does not render", !isRenderableSvg("<note><to>Tove</to></note>"));
  ok("nor does an HTML page containing an svg", !isRenderableSvg('<html><body><svg viewBox="0 0 1 1"><rect/></svg></body></html>'));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
