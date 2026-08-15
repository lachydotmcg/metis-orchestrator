// The generic local brand, and the rule that a local library entry must
// resolve to a real Ollama tag.
//
// What was wrong. Every brand id in the picker named a VENDOR — qwen, claude,
// glm, deepseek — so the local models with no vendor of their own could not be
// expressed as a ModelRef at all. Llama 3.1 8B, Gemma 3, Phi-4, Mistral Small,
// Moondream, LLaVA and both embedding models were in LOCAL_MODELS with real
// ollamaTags, recommended by the Benchmark and installable in one click, and
// then unpickable in the composer. A local-first app that installs a model for
// you and will not let you choose it.
//
// The sharp rule here is the SECOND one, and it is why this suite reads the
// source rather than only the mapper: a local-brand library entry whose name
// has no LOCAL_MODELS match resolves to no tag, and depthStageRefFor returns
// null for it — so pinning it to a depth rung writes nothing to the store and
// the level reads as configured while doing nothing. That failure is silent,
// which is exactly the class this repo keeps having to design out.
//
// Offline: no provider is called and no API key is read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { localBrandForTag } = await fromBuild("shared/model-catalogue.js");
const app = readFileSync(join(process.cwd(), "src", "renderer", "ui", "App.tsx"), "utf8");

section("A local tag is branded by its VENDOR, not by the runtime serving it");
{
  // Every Ollama entry used to land on "qwen", the picker's only local bucket.
  // Right for qwen3:8b, simply wrong for llama3.1:8b — and with the live
  // catalogue fetching whatever is actually pulled, the wrong half stopped
  // being hypothetical.
  check("a qwen tag", localBrandForTag("qwen3:8b"), "qwen");
  check("a qwen coder tag", localBrandForTag("qwen3-coder:30b"), "qwen");
  check("qwq is Qwen's too", localBrandForTag("qwq:32b"), "qwen");
  check("a glm tag", localBrandForTag("glm4:9b"), "glm");
  check("a deepseek distill", localBrandForTag("deepseek-r1:14b"), "deepseek");
  check("llama is not Qwen", localBrandForTag("llama3.1:8b"), "ollama");
  check("nor is gemma", localBrandForTag("gemma3:27b"), "ollama");
  check("nor is an embedding model", localBrandForTag("nomic-embed-text"), "ollama");
}

section("Only the tag PREFIX decides the vendor");
{
  // A model merely mentioning a vendor later in its name is not that vendor's.
  check("a mention after the prefix does not count", localBrandForTag("llama-qwen-merge:7b"), "ollama");
  check("the prefix is read before the colon", localBrandForTag("qwen2.5:72b"), "qwen");
  check("case does not matter", localBrandForTag("Qwen3:8B"), "qwen");
  check("junk falls back to the generic brand", localBrandForTag(""), "ollama");
  check("so does a non-string", localBrandForTag(undefined), "ollama");
}

section("The brand exists, and is named for the user rather than the runtime");
{
  ok("the id is in the union", /\|\s*"ollama"/.test(app));
  // "Local", not "Ollama": the group holds models from six vendors, and the
  // user picked a model, not a runtime.
  ok("it is labelled Local", /ollama:\s*\{\s*label:\s*"Local"/.test(app));
  ok("and it is a local tier", /ollama:\s*\{\s*label:\s*"Local",[^}]*tier:\s*"local"/.test(app));
  ok("it connects through ollama", /^\s*ollama:\s*"ollama",$/m.test(app));
  // The catalogue fallback moved off "qwen" so an unbranded tag lands sensibly
  // even when there is no tag to read.
  ok("the catalogue fallback is the generic brand", /groq:\s*"groq",\s*\n\s*ollama:\s*"ollama"\s*\n\};/.test(app));
}

section("EVERY local library entry resolves to a real tag");
{
  // The silent failure this guards. localOllamaTagFor matches LOCAL_MODELS by
  // NAME; a library entry with no match returns null, and depthStageRefFor
  // then returns null for it, so pinning it to a depth rung writes nothing
  // while the level reads as configured.
  const librarySource = app.slice(app.indexOf("const MODEL_LIBRARY: ModelRef[] = ["), app.indexOf("// Persisted via useAppStoreState(\"modelPresets\""));
  const localEntries = [...librarySource.matchAll(/\{\s*provider:\s*"ollama",\s*model:\s*"([^"]+)"\s*\}/g)].map((match) => match[1]);
  ok(`${localEntries.length} models were filed under the local brand`, localEntries.length >= 11);

  const localModelsSource = app.slice(app.indexOf("const LOCAL_MODELS: LocalModel[] = ["));
  const withTags = new Set(
    [...localModelsSource.matchAll(/\{\s*name:\s*"([^"]+)"[^}]*ollamaTag:\s*"([^"]+)"/g)].map((match) => match[1])
  );
  const unresolved = localEntries.filter((name) => !withTags.has(name));
  check("none of them resolves to nothing", unresolved, []);
}

section("A model with no tag is left out, not filed hopefully");
{
  // Ornith 1.0 35B is in LOCAL_MODELS with no ollamaTag — there is no way to
  // pull it. Filing it would have produced exactly the unresolvable entry the
  // section above forbids, so it is absent, and its absence is deliberate.
  const librarySource = app.slice(app.indexOf("const MODEL_LIBRARY: ModelRef[] = ["), app.indexOf("// Persisted via useAppStoreState(\"modelPresets\""));
  ok("the untagged model is not in the library", !librarySource.includes("Ornith"));
  ok("but it is still in the installable list", app.includes('name: "Ornith 1.0 35B"'));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
