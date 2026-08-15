// Mapping live provider model-lists into catalogue entries. Imports the real
// mappers from the build.
//
// What this exists to prevent: a hardcoded model list that goes stale silently
// between releases. On 2026-08-14 that stopped being theoretical — DeepSeek
// retired `deepseek-chat` and `deepseek-reasoner` on 2026-07-24 and Metis kept
// sending them from eleven call sites, so every DeepSeek route in v1.2.0 was
// pointing at a dead id and nothing in the app could notice, because nothing
// ever asked a provider what it actually serves.
//
// The sharpest rule pinned here is a REFUSAL: an OpenRouter entry never
// produces a direct first-party route, because OpenRouter's ids are not safely
// invertible and synthesising one would manufacture exactly the 404s this
// module exists to prevent.
//
// Offline: no provider is called and no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { mapOpenRouterModel, mapOllamaTag, isExpiredCatalogModel, mergeCatalogModels, LIVE_CATALOG_SOURCES } =
  await fromBuild("shared/model-catalogue.js");

section("An OpenRouter entry becomes a catalogue model");
{
  const mapped = mapOpenRouterModel({
    id: "anthropic/claude-opus-4.8",
    name: "Anthropic: Claude Opus 4.8",
    context_length: 200000,
    pricing: { prompt: "0.000005", completion: "0.000025" }
  });
  check("the id is preserved verbatim", mapped.id, "anthropic/claude-opus-4.8");
  check("it is a cloud model", mapped.tier, "cloud");
  // Per-token decimal strings become USD per million, which is what the app shows.
  check("input price per million", mapped.access[0].pricing.in, 5);
  check("output price per million", mapped.access[0].pricing.out, 25);
}

section("The route is openrouter ONLY, and that is a refusal not an omission");
{
  const mapped = mapOpenRouterModel({ id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" });
  check("exactly one route", mapped.access.length, 1);
  check("and it is openrouter", mapped.access[0].provider, "openrouter");
  // Inverting is unsafe: Anthropic's own id uses dashes and a different shape
  // (claude-opus-4-8), dated ids have their dates dropped by OpenRouter
  // entirely, and deepseek/deepseek-v4-flash is pinned to an OLDER snapshot
  // than DeepSeek's own deepseek-v4-flash. A synthesised direct route would be
  // a 404 generator.
  ok("no direct anthropic route is invented", !mapped.access.some((r) => r.provider === "anthropic"));
  const ds = mapOpenRouterModel({ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" });
  ok("nor a direct deepseek route", !ds.access.some((r) => r.provider === "deepseek"));
}

section("Pricing is all-or-nothing");
{
  // A half-priced route displays a total that is WRONG rather than incomplete,
  // and the usage display has no way to say "half known".
  const half = mapOpenRouterModel({ id: "x/y", name: "Y", pricing: { prompt: "0.000001" } });
  check("one price is no pricing", half.access[0].pricing, undefined);
  const free = mapOpenRouterModel({ id: "x/free", name: "Free", pricing: { prompt: "0", completion: "0" } });
  check("genuinely free is zero, not absent", free.access[0].pricing, { in: 0, out: 0 });
  const junk = mapOpenRouterModel({ id: "x/junk", name: "Junk", pricing: { prompt: "abc", completion: "def" } });
  check("unparseable is absent, never zero", junk.access[0].pricing, undefined);
  const negative = mapOpenRouterModel({ id: "x/neg", name: "Neg", pricing: { prompt: "-1", completion: "-1" } });
  check("negative is refused", negative.access[0].pricing, undefined);
}

section("Unusable entries are dropped rather than half-mapped");
check("no id", mapOpenRouterModel({ name: "Nameless" }), null);
check("empty id", mapOpenRouterModel({ id: "   " }), null);
check("undefined", mapOpenRouterModel({}), null);
{
  const noName = mapOpenRouterModel({ id: "x/y" });
  check("a missing name falls back to the id", noName.name, "x/y");
}

section("Ollama tags: the name IS the id, and it is free");
{
  const mapped = mapOllamaTag({ name: "qwen3:8b", size: 5200000000 });
  check("id", mapped.id, "qwen3:8b");
  check("name", mapped.name, "qwen3:8b");
  check("local tier", mapped.tier, "local");
  // Local inference costs nothing, and absent pricing is how the app renders that.
  check("no pricing", mapped.access[0].pricing, undefined);
  check("no name is dropped", mapOllamaTag({ size: 1 }), null);
}

section("Expiry: a declared retirement date drops the model");
{
  const now = new Date("2026-08-14T00:00:00Z");
  ok("no expiry means current", !isExpiredCatalogModel({}, now));
  ok("a future date is current", !isExpiredCatalogModel({ expiresAt: "2027-01-01T00:00:00Z" }, now));
  ok("a past date is expired", isExpiredCatalogModel({ expiresAt: "2026-07-01T00:00:00Z" }, now));
  // Hiding a working model is worse than showing a dead one: a dead one gives
  // the user an error they can read, a hidden one just looks unsupported.
  ok("an unparseable date is treated as no expiry", !isExpiredCatalogModel({ expiresAt: "soon" }, now));
}

section("Merging: live wins, bundled survives where live cannot reach");
{
  const now = new Date("2026-08-14T00:00:00Z");
  const bundled = [
    { provider: "openrouter", id: "a/b", name: "Stale Name", tier: "cloud", access: [] },
    // Neither Alibaba nor Z.ai publishes a model list, so these only ever come
    // from the bundled catalogue and must not be lost in a merge.
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "cloud", access: [] }
  ];
  const live = [{ provider: "openrouter", id: "a/b", name: "Fresh Name", tier: "cloud", access: [] }];
  const merged = mergeCatalogModels(bundled, live, now);
  check("no duplicate", merged.length, 2);
  check("live overwrote the bundled entry", merged.find((m) => m.id === "a/b").name, "Fresh Name");
  ok("the bundled-only provider survived", merged.some((m) => m.id === "deepseek-v4-pro"));
}
{
  const now = new Date("2026-08-14T00:00:00Z");
  const merged = mergeCatalogModels([], [{ provider: "openrouter", id: "old/model", name: "Old", tier: "cloud", access: [], expiresAt: "2026-01-01" }], now);
  check("expired entries are dropped at merge, not at the UI", merged.length, 0);
}
{
  // Case-insensitive keying: providers are inconsistent about casing and two
  // entries for one model would show as two rows in the picker.
  const now = new Date("2026-08-14T00:00:00Z");
  const merged = mergeCatalogModels(
    [{ provider: "openrouter", id: "A/B", name: "Upper", tier: "cloud", access: [] }],
    [{ provider: "openrouter", id: "a/b", name: "Lower", tier: "cloud", access: [] }],
    now
  );
  check("one entry, not two", merged.length, 1);
}

section("The live sources are declared, and neither needs a key");
{
  ok("both sources listed", LIVE_CATALOG_SOURCES.length === 2);
  ok("none needs auth", LIVE_CATALOG_SOURCES.every((s) => s.needsAuth === false));
  ok("ollama is loopback", LIVE_CATALOG_SOURCES.some((s) => s.provider === "ollama" && s.url.includes("127.0.0.1")));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
