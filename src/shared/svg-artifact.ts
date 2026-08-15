/** Deciding whether a fenced ```svg block is safe to DRAW rather than print.
 *
 *  Storage note, because it is the opposite decision to generated images and
 *  the difference is deliberate. An image is a real file on disk, so
 *  RenderedArtifact carries its path and the renderer fetches the bytes. An SVG
 *  is markup that is ALREADY in the run's assistantText, which is already in
 *  conversations.json — and that file is rewritten whole on every turn. Storing
 *  the markup a second time as an artifact would duplicate every chart in a
 *  file that gets re-serialised on every message, to save a parse that costs
 *  microseconds. So nothing is stored: detection happens where the fence is
 *  rendered, from text the record already holds.
 *
 *  Safety is structural, not a sanitiser. The renderer draws this through
 *  `<img src="data:image/svg+xml;base64,…">`, and an SVG loaded via <img> is
 *  handled in secure static mode: no script execution, no external resource
 *  loading, no interactivity. That is a browser guarantee. Nothing here strips
 *  <script> tags, on purpose — writing a sanitiser would imply the boundary
 *  needs one, and the day someone "improves" the sanitiser is the day the real
 *  guarantee gets quietly traded for a regex.
 *
 *  What this gate IS for is Metis routing to small local models. A 7B model
 *  emits unclosed tags, stray backticks and half-finished markup constantly. A
 *  broken render is worse than no render, so anything that does not pass falls
 *  back to being an ordinary code block.
 */

/** Above this, draw nothing and leave it as code. Generous for a hand-written
 *  chart, small enough that a runaway generation cannot hand the renderer a
 *  megabyte-long base64 string per message. */
export const SVG_ARTIFACT_MAX_CHARS = 512_000;

/** Fence labels worth TRYING as an SVG. Not a whitelist of things that will
 *  render — `isRenderableSvg` decides that — just of labels worth looking under.
 *
 *  This exists because of a real bug shipped in v1.2.0. The renderer tested for
 *  the label `svg` and nothing else, so when Qwen3 8B answered a chart request
 *  with a complete, correct SVG document inside an ```xml fence, it printed as
 *  code. The markup passed every check; the label filtered it out before any
 *  check ran.
 *
 *  That is the worst shape of bug for this app in particular. Ask Claude and you
 *  get ```svg and it works; ask a local 7B and you get ```xml and it does not —
 *  so the feature silently depends on WHICH MODEL ANSWERED, in a product whose
 *  entire argument is that you route across models.
 *
 *  So: gate on content, not on the label. An empty label counts, because plenty
 *  of models emit a bare fence. Anything not on this list stays code without
 *  being parsed, which keeps the cost of a wrong guess at zero. */
export function fenceMayBeSvg(language: string): boolean {
  if (typeof language !== "string") return false;
  const normalised = language.trim().toLowerCase();
  return normalised === "" || normalised === "svg" || normalised === "xml" || normalised === "html" || normalised === "markup";
}

/** Strips the things that may legally precede or follow a root <svg> element:
 *  an XML declaration, a doctype, comments, and whitespace. Everything else is
 *  content, and content outside the root means this is not a single drawable
 *  document. */
function stripOuterNoise(source: string): string {
  let text = source.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const before = text;
    text = text
      .replace(/^<\?xml[\s\S]*?\?>/i, "")
      .replace(/^<!DOCTYPE[^>]*>/i, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/<!--[\s\S]*?-->\s*$/, "")
      .trim();
    if (text !== before) changed = true;
  }
  return text;
}

/** True when this text is one complete SVG document and can be drawn.
 *
 *  Deliberately conservative in both directions: it never tries to repair
 *  anything, and it never draws something it is unsure about. */
export function isRenderableSvg(source: string): boolean {
  if (typeof source !== "string") return false;
  const raw = source.trim();
  if (!raw || raw.length > SVG_ARTIFACT_MAX_CHARS) return false;

  const text = stripOuterNoise(raw);
  if (!text) return false;

  // Must open with a real root element. `<svg` alone would also match
  // `<svgfoo`, so the next character has to end the tag name.
  if (!/^<svg[\s/>]/i.test(text)) return false;
  if (!text.endsWith("</svg>")) return false;

  // Depth, not counts. Counting opens and closes and comparing them cannot tell
  // ONE nested document from TWO siblings glued together — both balance. The
  // suite caught exactly that: two charts concatenated passed a count check and
  // would have rendered as only the first.
  //
  // So walk the tags in order. Depth must reach zero exactly once, on the very
  // last tag, and that tag must end the text. Self-closing roots (`<svg … />`)
  // have no closing tag and are vanishingly rare in generated output, so they
  // are simply not drawn rather than special-cased.
  const tags = [...text.matchAll(/<svg[\s/>]|<\/svg\s*>/gi)];
  if (!tags.length) return false;
  let depth = 0;
  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth < 0) return false;
    // Back to zero before the end means a second root follows.
    if (depth === 0 && i !== tags.length - 1) return false;
  }
  if (depth !== 0) return false;

  // Nothing may follow the root close. Without this, "</svg> and here is how it
  // works" draws the chart and silently eats the model's explanation.
  const last = tags[tags.length - 1];
  if (last.index === undefined || last.index + last[0].length !== text.length) return false;

  return true;
}

/** The data URL the renderer paints. Base64 rather than percent-encoding
 *  because SVG markup is full of characters (#, %, quotes) that make a raw
 *  data: URL fragile in ways that are tedious to debug and invisible in
 *  review. Returns "" when the source should not be drawn at all, so a caller
 *  that forgets to gate still cannot render junk. */
export function svgDataUrl(source: string, encode: (value: string) => string): string {
  if (!isRenderableSvg(source)) return "";
  return `data:image/svg+xml;base64,${encode(source.trim())}`;
}
