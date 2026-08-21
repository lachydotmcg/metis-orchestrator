/** The Ollama client: what is installed, pulling a model, and picking one that
 *  can see.
 *
 *  Eighth carve of docs/STRUCTURAL_DEBT.md item 1, and it was found by a
 *  mislabelled banner rather than by the map. The section header above these
 *  functions read "Gallery visual RAG" — three gallery TYPES are declared under
 *  it, and then 170 lines of Ollama HTTP client. Rule 4 says the last function
 *  under a banner tends to belong to the next section; this is the same failure
 *  at the scale of a whole block, and the measurement reported it as "gallery,
 *  182 lines, zero dependencies" because it counts lines, not meanings.
 *
 *  **Zero dependencies on main.ts**, so it is imported rather than injected —
 *  and that is the point. `listOllamaModels` was being INJECTED into
 *  `gateway.ts`, `loop-runtime.ts` and `providers.ts`, three separate
 *  dependency interfaces carrying the same function because it lived in a file
 *  none of them could import. All three now import it directly and their
 *  interfaces shrink.
 *
 *  Nothing here imports electron. It is HTTP to 127.0.0.1:11434 and nothing
 *  else, which is why `37-ollama-client` can drive it against a fake server.
 */

import { appendAudit, readStoreValue } from "./store.js";
import type { OllamaListResult, OllamaPullProgress } from "../shared/runtime-contracts.js";

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/** Vision-capable Ollama model name families, in the owner's priority order
 *  (gemma preferred; see docs/FABLE_PLANS.md sections 4 and 17). Matched
 *  case-insensitively against installed model names/families. */
export const VISION_MODEL_PRIORITY = ["gemma", "qwen-vl", "qwen2-vl", "qwen2.5vl", "llama3.2-vision", "llava", "bakllava", "minicpm-v", "moondream"];

let cachedVisionModel: string | null | undefined; // undefined = not yet detected this run

/** Resolves the vision model to use for gallery captioning/analysis, honoring
 *  the owner's `visionModel` app-store override (renderer-set picker) when
 *  present, and otherwise falling back to the existing auto-detect. If a
 *  configured value is set but Ollama's `/api/tags` is reachable and doesn't
 *  list it, the override is treated as stale (e.g. the model was removed) and
 *  we fall back to auto-detect rather than hard-failing the analyze — the
 *  store read itself is also guarded so a malformed/missing value can never
 *  break analysis. */
export async function resolveConfiguredVisionModel(): Promise<string | null> {
  let configured = "";
  try {
    configured = (await readStoreValue<string>("visionModel", "")).trim();
  } catch {
    configured = "";
  }
  if (!configured) {
    return detectOllamaVisionModel();
  }
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (response.ok) {
      const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const installed = (payload.models ?? []).map((entry) => entry.name ?? entry.model).filter(Boolean) as string[];
      if (installed.length && !installed.includes(configured)) {
        await appendAudit(
          "warning",
          "gallery.vision",
          `Configured vision model "${configured}" isn't installed in Ollama; falling back to auto-detect.`,
          { configured }
        );
        return detectOllamaVisionModel();
      }
    }
  } catch {
    // Ollama /api/tags unreachable or returned something unexpected — trust the
    // configured value as-is (it may be a cloud vision model, not a local tag).
  }
  return configured;
}

/** Detects an installed Ollama vision-capable model by scanning `/api/tags`,
 *  cached per app run. Never downloads anything. Returns null on any failure
 *  or when no vision-capable family is installed (fail soft). */
export async function detectOllamaVisionModel(): Promise<string | null> {
  if (cachedVisionModel !== undefined) return cachedVisionModel;
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      cachedVisionModel = null;
      return null;
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string; details?: { family?: string; families?: string[] } }> };
    const models = payload.models ?? [];
    for (const family of VISION_MODEL_PRIORITY) {
      const match = models.find((entry) => {
        const haystack = [entry.name, entry.model, entry.details?.family, ...(entry.details?.families ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(family);
      });
      if (match) {
        cachedVisionModel = match.name ?? match.model ?? null;
        return cachedVisionModel;
      }
    }
    cachedVisionModel = null;
    return null;
  } catch {
    cachedVisionModel = null;
    return null;
  }
}

/** Lists installed Ollama models via `/api/tags`. Never throws — any failure
 *  (Ollama not running, network error, bad JSON) is reported as unreachable
 *  rather than propagated (docs/FABLE_PLANS.md §17/§18). */
export async function listOllamaModels(): Promise<OllamaListResult> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return { reachable: false, installed: [] };
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const installed = (payload.models ?? []).map((entry) => entry.name).filter((name): name is string => Boolean(name));
    return { reachable: true, installed };
  } catch {
    return { reachable: false, installed: [] };
  }
}

/** Pulls (installs) an Ollama model, streaming NDJSON progress lines from
 *  `/api/pull` back to the renderer via `metis-ollama:pull-progress`. Buffers
 *  partial lines across chunk boundaries since a chunk may split a JSON
 *  object mid-line. Never throws out of this function — all failure paths
 *  emit a terminal `{ done: true, error }` event and resolve with `{ ok: false }`
 *  (docs/FABLE_PLANS.md §17/§18). */
export async function pullOllamaModel(
  modelName: string,
  emitProgress: (progress: OllamaPullProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true })
    });
    if (!response.ok || !response.body) {
      const error = `Ollama pull request failed (${response.status})`;
      emitProgress({ model: modelName, status: "error", done: true, error });
      return { ok: false, error };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): { stop: boolean; error?: string } => {
      const trimmed = line.trim();
      if (!trimmed) return { stop: false };
      let parsed: { status?: string; completed?: number; total?: number; error?: string };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return { stop: false };
      }
      if (parsed.error) {
        emitProgress({ model: modelName, status: "error", done: true, error: parsed.error });
        return { stop: true, error: parsed.error };
      }
      emitProgress({
        model: modelName,
        status: parsed.status ?? "",
        completed: parsed.completed,
        total: parsed.total,
        done: false
      });
      return { stop: false };
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const result = handleLine(line);
        if (result.stop) return { ok: false, error: result.error };
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) {
      const result = handleLine(buffer);
      if (result.stop) return { ok: false, error: result.error };
    }

    emitProgress({ model: modelName, status: "success", done: true });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitProgress({ model: modelName, status: "error", done: true, error: message });
    return { ok: false, error: message };
  }
}
