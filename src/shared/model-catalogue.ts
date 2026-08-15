/** Turning live provider model-lists into catalogue entries.
 *
 *  This exists because a hardcoded model list goes stale silently between
 *  releases, and on 2026-08-14 that stopped being theoretical: DeepSeek retired
 *  `deepseek-chat` and `deepseek-reasoner` on 2026-07-24 and Metis kept sending
 *  them from eleven call sites, so every DeepSeek route in v1.2.0 was pointing
 *  at a dead id. Nothing in the app could have noticed, because nothing ever
 *  asked a provider what it actually serves.
 *
 *  Two sources, chosen because neither can go stale the way a list in source
 *  can (docs/MODEL_CATALOGUE.md):
 *
 *  - OpenRouter's `/api/v1/models`, which needs NO auth and returns pricing,
 *    context length and expiry dates for hundreds of models in one call.
 *  - Ollama's `/api/tags`, where the `name` field IS the id and cannot 404
 *    because the weights are on the user's disk.
 *
 *  Pure and transport-free on purpose: main does the fetching (the renderer
 *  does no outbound network — see isRegistryFetchUrl), and these functions are
 *  handed already-parsed JSON so the offline suite can exercise the real
 *  mapping rather than a copy of it.
 */

import type { CatalogModel, ModelAccessRoute, ProviderKey } from "./runtime-contracts.js";

/** One entry as OpenRouter returns it. Deliberately loose: their payload has
 *  far more fields than this and gains more over time, and a strict shape would
 *  make an added field look like a parse failure. */
export interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  expiration_date?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
}

/** One entry from Ollama's /api/tags. */
export interface OllamaTag {
  name?: unknown;
  size?: unknown;
}

const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** OpenRouter prices are per-token, as decimal STRINGS ("0.000003"), and the
 *  app displays USD per million. Returns undefined rather than 0 for a missing
 *  or unparseable price, because 0 renders as "free" and a wrong "free" on a
 *  paid model is worse than an honest blank. */
function perMillion(raw: unknown): number | undefined {
  const value = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value * 1_000_000;
}

/** Maps one OpenRouter entry to a catalogue model, or null if it is unusable.
 *
 *  The route is recorded as `openrouter` ONLY, never as a direct provider
 *  route, and that is a deliberate refusal rather than an omission.
 *  OpenRouter's ids are not safely invertible to first-party ids: Anthropic's
 *  `claude-opus-4-8` is `anthropic/claude-opus-4.8` there (dots for dashes),
 *  dated ids have their dates dropped entirely, and
 *  `deepseek/deepseek-v4-flash` is pinned to an OLDER snapshot than DeepSeek's
 *  own `deepseek-v4-flash`. Synthesising a direct route from an OpenRouter id
 *  would manufacture exactly the 404s this module exists to prevent. */
export function mapOpenRouterModel(raw: OpenRouterModel): CatalogModel | null {
  const id = asString(raw?.id);
  if (!id) return null;
  const name = asString(raw?.name) || id;

  const route: ModelAccessRoute = { provider: "openrouter", id };
  const input = perMillion(raw?.pricing?.prompt);
  const output = perMillion(raw?.pricing?.completion);
  // Both or neither: a half-priced route displays a total that is wrong rather
  // than incomplete, and the Usage tab has no way to show "half known".
  if (input !== undefined && output !== undefined) route.pricing = { in: input, out: output };

  const model: CatalogModel = { provider: "openrouter", id, name, tier: "cloud", access: [route] };
  const expires = asString(raw?.expiration_date);
  if (expires) model.expiresAt = expires;
  return model;
}

/** Maps one Ollama tag. The name IS the id — there is no separate display id
 *  and no pricing, because local inference is free. */
export function mapOllamaTag(raw: OllamaTag): CatalogModel | null {
  const name = asString(raw?.name);
  if (!name) return null;
  return { provider: "ollama", id: name, name, tier: "local", access: [{ provider: "ollama", id: name }] };
}

/** Whether a catalogue entry has passed its provider-declared expiry.
 *
 *  Only `expiresAt` counts. A model with no expiry is current, and an
 *  unparseable date is treated as no expiry rather than as expired — the
 *  failure mode of hiding a working model is worse than showing a dead one,
 *  because a dead one produces an error the user can read while a hidden one
 *  just looks like Metis does not support it. */
export function isExpiredCatalogModel(model: Pick<CatalogModel, "expiresAt">, now: Date): boolean {
  if (!model.expiresAt) return false;
  const at = new Date(model.expiresAt).getTime();
  if (!Number.isFinite(at)) return false;
  return at <= now.getTime();
}

/** Merges live entries over cached/bundled ones, keyed by provider+id.
 *
 *  Live wins on collision, because the whole point is that the live source is
 *  the one that cannot be stale. Bundled entries survive for providers the live
 *  sources do not cover — neither Alibaba nor Z.ai publishes a model list, so
 *  Qwen and GLM stay hardcoded, and the direct Anthropic/OpenAI/DeepSeek routes
 *  are not derivable from OpenRouter ids (see mapOpenRouterModel).
 *
 *  Expired entries are dropped here rather than filtered at the UI, so nothing
 *  downstream has to remember to check. */
export function mergeCatalogModels(bundled: CatalogModel[], live: CatalogModel[], now: Date): CatalogModel[] {
  const key = (model: CatalogModel) => `${model.provider}::${model.id.toLowerCase()}`;
  const merged = new Map<string, CatalogModel>();
  for (const model of bundled) merged.set(key(model), model);
  for (const model of live) merged.set(key(model), model);
  return [...merged.values()].filter((model) => !isExpiredCatalogModel(model, now));
}

/** The $/Mtok of the catalogue route matching a SERVING provider + model id,
 *  or null when nothing in the catalogue covers it.
 *
 *  Null is the honest answer and must stay distinguishable from free: a route
 *  Metis has no price for is not a route that costs nothing. */
export function routePricing(catalog: readonly CatalogModel[], provider: string, model: string): { in: number; out: number } | null {
  for (const entry of catalog) {
    const route = (entry.access ?? []).find((candidate) => candidate.provider === provider && candidate.id === model);
    if (route?.pricing) return route.pricing;
  }
  return null;
}

/** Display-only cost for one billed row, as the Usage tab and the loop
 *  walkthrough both render it.
 *
 *  Shared rather than duplicated on purpose: two places formatting money from
 *  the same ledger with independently-written rules is how one of them ends up
 *  quietly rounding a different way from the other. Three honesty rules are
 *  carried here:
 *   - a local (`ollama`) row is "Free", because it genuinely is;
 *   - an unknown price is an em dash, never `$0.00`, because "we do not know"
 *     and "it cost nothing" are different claims;
 *   - an estimated token count keeps its `~`, so a char-count guess never
 *     renders with the authority of a provider-reported number. */
export function costLabel(
  pricing: { in: number; out: number } | null,
  row: { provider: string; inputTokens: number; outputTokens: number; estimated?: boolean }
): string {
  if (row.provider === "ollama") return "Free";
  if (!pricing) return "—";
  const cost = (row.inputTokens * pricing.in + row.outputTokens * pricing.out) / 1_000_000;
  const prefix = row.estimated ? "~" : "";
  return cost >= 0.01 ? `${prefix}$${cost.toFixed(2)}` : `${prefix}<$0.01`;
}

/** The providers a live fetch can populate, so callers do not guess. */
export const LIVE_CATALOG_SOURCES: ReadonlyArray<{ provider: ProviderKey; url: string; needsAuth: boolean }> = [
  { provider: "openrouter", url: "https://openrouter.ai/api/v1/models", needsAuth: false },
  { provider: "ollama", url: "http://127.0.0.1:11434/api/tags", needsAuth: false }
];
