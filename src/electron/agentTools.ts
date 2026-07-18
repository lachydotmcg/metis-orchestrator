/** Agentic tools, phase 1 (docs/DRILL_PLAN.md CORE.4, designed in
 *  docs/AGENTIC_TOOLS.md).
 *
 *  THE PROBLEM THIS SOLVES: today a model is handed a blob of file contents
 *  and must reply with whole replacement files, blind. It cannot look at a
 *  file it was not given, cannot check what exists, and cannot make a
 *  surgical change. A CLI sweep caught the cost of that blindness directly:
 *  asked to extract a repeated constant, the model never read the file and
 *  INVENTED a plausible-but-wrong key name.
 *
 *  Phase 1 is deliberately the three tools that fix exactly that, and no
 *  more: look, list, and change one exact thing. run_command is NOT here. It
 *  is the only tool whose blast radius is the host OS rather than a folder,
 *  and per the design doc it ships last, narrowest, and separately.
 *
 *  Two safety properties this module owns, and neither is optional:
 *   - CONTAINMENT: every path argument resolves inside the project root, via
 *     the same trailing-separator check the rest of the app now uses, plus a
 *     realpath pass so a symlink cannot point out. Rejection is an explicit
 *     error handed back to the model, never a silent skip.
 *   - NO SECRETS: dotfiles and credential-shaped names are refused outright,
 *     because "the model asked nicely" is not an access-control policy.
 *
 *  Writes go through the caller's normal write path, so the CORE.5 snapshot
 *  safety net applies to anything a tool changes. This module never writes
 *  directly. */

import { readFile, readdir, stat, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export type AgentToolName = "read_file" | "list_files" | "edit_file";

export interface AgentToolCall {
  tool: AgentToolName;
  path?: string;
  find?: string;
  replace?: string;
}

export interface AgentToolResult {
  ok: boolean;
  /** Text handed back to the model. Errors are text too: a model that knows
   *  WHY something failed can correct itself; a silent failure teaches it
   *  nothing and it will simply invent an answer instead. */
  text: string;
  /** Set by edit_file: the caller writes this through its normal, snapshotted
   *  write path rather than this module touching disk. */
  pendingWrite?: { relativePath: string; content: string };
}

/** Files a model may never read, whatever it claims to need them for. */
const SECRET_PATTERNS = [/^\.env/i, /(^|[._-])secret/i, /(^|[._-])credential/i, /\.pem$/i, /\.key$/i, /id_rsa/i, /\.pfx$/i];

const READABLE_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".cs", ".css", ".go", ".h", ".html", ".htm", ".java", ".js", ".json", ".jsx", ".kt",
  ".md", ".mjs", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".svg", ".swift", ".toml",
  ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml"
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".cache", "coverage", ".vite"]);

const MAX_READ_BYTES = 60_000;
const MAX_LIST_ENTRIES = 200;

function isSecretPath(relativePath: string): boolean {
  const name = basename(relativePath);
  return SECRET_PATTERNS.some((pattern) => pattern.test(name));
}

/** Containment: resolved target must sit inside root, with a trailing
 *  separator so a sibling folder sharing a name prefix cannot pass. */
function isInside(child: string, parent: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  if (childResolved.toLowerCase() === parentResolved.toLowerCase()) return true;
  const withSep = parentResolved.endsWith(sep) ? parentResolved : parentResolved + sep;
  return childResolved.toLowerCase().startsWith(withSep.toLowerCase());
}

/** Resolves a model-supplied path against the project root, refusing anything
 *  outside it, secret-shaped, or reachable only through a symlink that
 *  escapes. Returns an error STRING (not a throw) so the caller can hand the
 *  reason straight back to the model. */
async function resolveToolPath(root: string, rawPath: string | undefined): Promise<{ full: string; relative: string } | { error: string }> {
  const candidate = (rawPath ?? "").trim();
  if (!candidate) return { error: "No path was given. Provide a path relative to the project root." };
  if (candidate.includes("\0")) return { error: "That path is not valid." };

  const full = resolve(root, candidate);
  if (!isInside(full, root)) {
    return { error: `Refused: "${candidate}" is outside the project folder. Only paths inside the project can be used.` };
  }
  const rel = relative(resolve(root), full).split(sep).join("/");
  if (isSecretPath(rel)) {
    return { error: `Refused: "${rel}" looks like a secrets or credentials file, which Metis never exposes to a model.` };
  }
  const real = await realpath(full).catch(() => null);
  if (real && !isInside(real, root)) {
    return { error: `Refused: "${rel}" resolves outside the project folder through a link.` };
  }
  return { full, relative: rel };
}

async function toolReadFile(root: string, call: AgentToolCall): Promise<AgentToolResult> {
  const resolved = await resolveToolPath(root, call.path);
  if ("error" in resolved) return { ok: false, text: resolved.error };
  try {
    const info = await stat(resolved.full);
    if (!info.isFile()) return { ok: false, text: `"${resolved.relative}" is not a file.` };
    if (info.size > MAX_READ_BYTES) {
      const partial = await readFile(resolved.full, "utf8");
      return {
        ok: true,
        text: `${resolved.relative} (truncated, first ${MAX_READ_BYTES} of ${info.size} bytes):\n${partial.slice(0, MAX_READ_BYTES)}`
      };
    }
    const content = await readFile(resolved.full, "utf8");
    return { ok: true, text: `${resolved.relative}:\n${content}` };
  } catch {
    return { ok: false, text: `Could not read "${resolved.relative}". It may not exist.` };
  }
}

async function toolListFiles(root: string, call: AgentToolCall): Promise<AgentToolResult> {
  const target = (call.path ?? ".").trim() || ".";
  const resolved = await resolveToolPath(root, target);
  if ("error" in resolved) return { ok: false, text: resolved.error };
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || found.length >= MAX_LIST_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= MAX_LIST_ENTRIES) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
      } else if (READABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(relative(resolve(root), child).split(sep).join("/"));
      }
    }
  }
  await walk(resolved.full, 0);
  if (found.length === 0) return { ok: true, text: `No readable source files found under "${resolved.relative || "."}".` };
  return { ok: true, text: `Files under "${resolved.relative || "."}" (${found.length}):\n${found.join("\n")}` };
}

/** A targeted replace, not a whole-file rewrite. The `find` text must appear
 *  EXACTLY ONCE: zero matches means the model is guessing, several means the
 *  change is ambiguous. Both are refused with a reason, which is what turns a
 *  hallucinated edit into a correctable mistake. */
async function toolEditFile(root: string, call: AgentToolCall): Promise<AgentToolResult> {
  const resolved = await resolveToolPath(root, call.path);
  if ("error" in resolved) return { ok: false, text: resolved.error };
  const find = call.find ?? "";
  const replace = call.replace ?? "";
  if (!find) return { ok: false, text: "edit_file needs a non-empty \"find\" string to locate the exact text to change." };

  let content: string;
  try {
    content = await readFile(resolved.full, "utf8");
  } catch {
    return { ok: false, text: `Could not read "${resolved.relative}" to edit it. Read it first to confirm it exists.` };
  }

  const occurrences = content.split(find).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      text: `The text to find was not present in "${resolved.relative}". Read the file and copy the exact text, including whitespace.`
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      text: `The text to find appears ${occurrences} times in "${resolved.relative}", so the edit is ambiguous. Include more surrounding context to make it unique.`
    };
  }

  return {
    ok: true,
    text: `Prepared an edit to ${resolved.relative} (1 replacement).`,
    pendingWrite: { relativePath: resolved.relative, content: content.replace(find, replace) }
  };
}

export async function executeAgentTool(root: string, call: AgentToolCall): Promise<AgentToolResult> {
  switch (call.tool) {
    case "read_file":
      return toolReadFile(root, call);
    case "list_files":
      return toolListFiles(root, call);
    case "edit_file":
      return toolEditFile(root, call);
    default:
      return { ok: false, text: `Unknown tool "${String((call as AgentToolCall).tool)}".` };
  }
}

/** Parses the FIRST tool directive out of a model reply. Mirrors the shape
 *  the shipped MCP loop already uses (P10.2) rather than inventing a second
 *  protocol, and tolerates the fenced/prose-wrapped JSON models actually
 *  emit. Returns null when there is no directive, which is how the loop
 *  knows the model is done. */
export function parseAgentToolCall(text: string): AgentToolCall | null {
  const marker = '"agent_tool_call"';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  // Walk back to the enclosing object, then brace-match forward so trailing
  // prose or a closing fence cannot break the parse.
  const start = text.lastIndexOf("{", markerIndex);
  if (start < 0) return null;
  // Brace matching must IGNORE braces inside string values. The find/replace
  // arguments carry source code, which is full of them: the first real tool
  // call this ever saw was
  //   {"tool":"edit_file","find":"function calculateStreak(habit) {"}
  // and a naive counter treated that trailing brace as nesting, never
  // balanced, and silently dropped a perfectly good edit. Track string state
  // and backslash escapes.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1)) as { agent_tool_call?: AgentToolCall };
          const call = parsed.agent_tool_call;
          if (!call || typeof call.tool !== "string") return null;
          if (call.tool !== "read_file" && call.tool !== "list_files" && call.tool !== "edit_file") return null;
          return call;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The instruction block that teaches a model these tools. Kept blunt and
 *  short: the live testing this session proved that stacked, polite
 *  instructions are the first thing a small model drops. */
export function agentToolsPromptBlock(): string {
  return [
    "You can inspect and change this project with tools. To use one, reply with ONLY this JSON and nothing else:",
    '{"agent_tool_call": {"tool": "read_file", "path": "app.js"}}',
    '{"agent_tool_call": {"tool": "list_files", "path": "."}}',
    '{"agent_tool_call": {"tool": "edit_file", "path": "app.js", "find": "exact text to replace", "replace": "new text"}}',
    "Rules:",
    "- READ a file before you edit it. Never guess at what it contains.",
    "- For edit_file, the find text must appear EXACTLY ONCE. Include surrounding lines to make it unique.",
    "- One tool call per reply. You will be given the result and can then call another.",
    "- When the work is done, reply normally with your answer and no JSON."
  ].join("\n");
}
