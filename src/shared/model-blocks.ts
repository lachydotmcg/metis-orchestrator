/** The fenced blocks a model may emit that Metis turns into something other
 *  than prose, declared in one place instead of four.
 *
 *  Four parsers grew independently and share a shape nobody had written down:
 *  match a fence, parse the payload, validate it, and turn it into a thing.
 *  The shape being undeclared had a cost — each parser also picked its own
 *  SELECTION and STRIPPING policy, and those differences are load-bearing but
 *  looked accidental. metis-loop takes the LAST block because a model that
 *  reasons out loud may show an example first. metis-actions is anchored to
 *  the END of the reply and is stripped from the visible text. Neither is
 *  arbitrary; neither was findable without reading both parsers.
 *
 *  Fences, never XML tags. Claude.ai can use `<antArtifact>` because one model
 *  is trained to emit it. Metis routes across seven cloud providers and Ollama,
 *  and its own argument is that trivial work stays on a local 7B — which will
 *  not reliably emit well-formed XML interleaved with prose, but will emit a
 *  fenced code block, having seen millions. extractManagerActions already
 *  chose a fence for exactly this reason.
 *
 *  ## The boundary field is the point
 *
 *  Every block type has to answer "what is this allowed to become", and until
 *  now that answer lived in whichever file happened to render it. An SVG
 *  becomes an `<img>` data URL, which cannot execute script whatever the markup
 *  contains — a browser guarantee rather than a sanitiser. HTML would need the
 *  iframe and origin work that is not built. Making `boundary` a required field
 *  means the next block type cannot be added without someone deciding.
 */

/** How to pick which occurrence of a tag counts, when a reply has several. */
export type BlockSelection =
  /** The last one. A model that reasons out loud may show an example earlier;
   *  the real answer is the one it ends on. */
  | "last"
  /** Only when it sits at the very end of the reply. Stricter than "last":
   *  a block with prose after it was not the model's final word. */
  | "trailing";

/** What a block is permitted to become once parsed. Required, so that adding a
 *  block type forces the question rather than leaving it to the renderer. */
export type BlockBoundary =
  /** Steers the run. Never displayed, never rendered. */
  | "control"
  /** Becomes UI the user acts on — cards with approve/dismiss. The payload is
   *  data, and nothing in it is ever evaluated. */
  | "action-cards"
  /** Drawn through an `<img>` data URL. Cannot execute script regardless of
   *  content, which is a property of `<img>` rather than of any sanitiser. */
  | "img-data-url";

export interface ModelBlockType {
  /** The fence info string, e.g. "metis-loop" for ```metis-loop. */
  tag: string;
  selection: BlockSelection;
  /** Whether the block is removed from the text the user is shown. Control and
   *  action blocks are Metis talking to itself and are stripped; a rendered
   *  block is the reply and stays. */
  strip: boolean;
  boundary: BlockBoundary;
  /** One line, for humans reading the registry rather than the parsers. */
  purpose: string;
}

/** Every tagged block type in the app. Adding one here is not enough to make it
 *  work — the parser still has to exist — but a parser whose type is NOT here
 *  is one nobody can find. */
export const MODEL_BLOCK_TYPES: readonly ModelBlockType[] = [
  {
    tag: "metis-loop",
    selection: "last",
    strip: true,
    boundary: "control",
    purpose: "A loop turn's continue/stop verdict, its delay, and any helpers it wants spawned."
  },
  {
    tag: "metis-actions",
    selection: "trailing",
    strip: true,
    boundary: "action-cards",
    purpose: "Actions a chat turn proposes, shown as cards the owner approves or dismisses."
  },
  {
    tag: "svg",
    selection: "last",
    strip: false,
    boundary: "img-data-url",
    purpose: "A diagram or chart, drawn in the bubble instead of printed as code."
  }
];

export function modelBlockType(tag: string): ModelBlockType | undefined {
  return MODEL_BLOCK_TYPES.find((entry) => entry.tag === tag);
}

/** Finds a tagged fence's payload, applying the type's selection policy.
 *
 *  Returns the raw inner text and the span it occupied, so a caller that needs
 *  to strip it does not have to re-find it — re-finding was how the two
 *  existing parsers ended up with subtly different regexes for the same job.
 *
 *  Deliberately does NOT parse. Parsing is per-type (JSON for two of these,
 *  markup for the third) and a registry that tried to own it would have to
 *  know every payload shape. */
export function findBlock(text: string, tag: string): { payload: string; start: number; end: number } | null {
  if (typeof text !== "string" || !text.includes(tag)) return null;
  const type = modelBlockType(tag);
  if (!type) return null;

  // The tag is fixed by the registry, never user input, but escaping it keeps
  // this honest if that ever stops being true.
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = type.selection === "trailing" ? new RegExp("```" + escaped + "\\s*([\\s\\S]*?)```\\s*$") : new RegExp("```" + escaped + "\\s*([\\s\\S]*?)```", "g");

  if (type.selection === "trailing") {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) return null;
    return { payload: match[1].trim(), start: match.index, end: match.index + match[0].length };
  }

  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  if (last.index === undefined) return null;
  return { payload: last[1].trim(), start: last.index, end: last.index + last[0].length };
}

/** The visible reply with a block removed, for types whose `strip` is true.
 *  Returns the text unchanged when the type does not strip or nothing matched,
 *  so a caller can apply it unconditionally. */
export function stripBlock(text: string, tag: string): string {
  const type = modelBlockType(tag);
  if (!type?.strip) return text;
  const found = findBlock(text, tag);
  if (!found) return text;
  return (text.slice(0, found.start) + text.slice(found.end)).trimEnd();
}
