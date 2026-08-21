// The Ollama client: what is installed, and how it fails.
//
// This module was invisible to every subsystem map, because it sat under a
// section banner reading "Gallery visual RAG" (docs/STRUCTURAL_DEBT.md item 1,
// eighth carve). The measurement reported it as "gallery, 182 lines, zero
// dependencies" — it counts lines, not meanings.
//
// What it does is decide whether Metis has any local model at all. Every
// failure is a availability question answered wrongly: an unreachable daemon
// read as "no models installed" is correct, but a malformed response read the
// same way hides a real problem, and a hang with no timeout stalls whatever
// asked.
//
// Driven against a FAKE server on a random port. It never contacts the real
// Ollama — which matters on this machine specifically, where Ollama IS running
// with six models, and an accidental real call is a test that passes here and
// fails on CI. That exact mistake was made and reverted while writing this.

import { createServer } from "node:http";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const ollama = await fromBuild("electron/ollama.js");

// A fake daemon we fully control, so every branch is reachable.
let reply = { status: 200, body: JSON.stringify({ models: [] }) };
const server = createServer((req, res) => {
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(reply.body);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

// The module reads a module-level constant for its base URL, so the fake is
// reached by pointing fetch at it rather than by reconfiguring the module.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).replace("http://127.0.0.1:11434", `http://127.0.0.1:${port}`), init);

section("The base URL is loopback, and it is not configurable by accident");
{
  // A model daemon on a non-loopback address would be someone else's machine
  // running your prompts.
  ok("it is 127.0.0.1", ollama.OLLAMA_BASE_URL.startsWith("http://127.0.0.1:"));
  ok("on the standard port", ollama.OLLAMA_BASE_URL.endsWith(":11434"));
}

section("Installed models are listed, and the shape is normalised");
{
  reply = { status: 200, body: JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "llama3.1:8b" }] }) };
  const result = await ollama.listOllamaModels();
  ok("reachable", result.reachable === true);
  check("both names come back", result.installed, ["qwen3:8b", "llama3.1:8b"]);
}

section("Every failure reads as unreachable rather than throwing");
{
  // The contract the whole app depends on: this function never throws, because
  // every caller is asking "is there a local model" and an exception is not an
  // answer to that.
  reply = { status: 500, body: "server exploded" };
  const failed = await ollama.listOllamaModels();
  check("a 500 is unreachable", failed.reachable, false);
  check("with an empty list, not undefined", failed.installed, []);

  reply = { status: 200, body: "not json at all" };
  const garbage = await ollama.listOllamaModels();
  check("unparseable JSON is unreachable", garbage.reachable, false);
  check("still an empty list", garbage.installed, []);

  // Valid JSON of the wrong shape is the interesting one: it is a 200, so the
  // request succeeded, and `models` is absent. Reporting reachable-with-nothing
  // is the honest answer — the daemon answered, it just has no models.
  reply = { status: 200, body: JSON.stringify({ unexpected: true }) };
  const wrongShape = await ollama.listOllamaModels();
  check("a 200 with no models list is still reachable", wrongShape.reachable, true);
  check("and reports nothing installed", wrongShape.installed, []);

  reply = { status: 200, body: JSON.stringify({ models: [{ noName: 1 }, { name: "good:1b" }] }) };
  const partial = await ollama.listOllamaModels();
  check("entries without a name are dropped, the rest kept", partial.installed, ["good:1b"]);
}

section("Nothing reachable at all");
{
  // The most common real state: Ollama not installed, or not running.
  globalThis.fetch = (url, init) => realFetch(String(url).replace("http://127.0.0.1:11434", "http://127.0.0.1:1"), init);
  const down = await ollama.listOllamaModels();
  check("a refused connection is unreachable", down.reachable, false);
  check("and not an exception", down.installed, []);
  globalThis.fetch = (url, init) => realFetch(String(url).replace("http://127.0.0.1:11434", `http://127.0.0.1:${port}`), init);
}

section("Vision-model priority is an ordered preference, not a set");
{
  // The order is the owner's judgement about which families actually see well.
  // Asserted as an ORDER because a Set or a re-sort would silently change which
  // model gets picked for an image.
  const priority = ollama.VISION_MODEL_PRIORITY;
  ok("it is a list", Array.isArray(priority));
  ok("with more than one family", priority.length > 1);
  ok("and no duplicates, which would make the order meaningless", new Set(priority).size === priority.length);
  ok("every entry is a lowercase family prefix", priority.every((p) => typeof p === "string" && p === p.toLowerCase()));
}

section("Vision detection picks by priority, and admits when it cannot");
{
  reply = { status: 200, body: JSON.stringify({ models: [{ name: "llama3.1:8b" }, { name: "qwen2.5:7b" }] }) };
  check("no vision model among them returns null", await ollama.detectOllamaVisionModel(), null);

  reply = { status: 200, body: JSON.stringify({ models: [] }) };
  check("an empty daemon returns null", await ollama.detectOllamaVisionModel(), null);

  reply = { status: 500, body: "down" };
  check("an unreachable daemon returns null rather than throwing", await ollama.detectOllamaVisionModel(), null);
}

globalThis.fetch = realFetch;
await new Promise((done) => server.close(done));

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
// `process.exitCode` rather than `process.exit()`, unlike the other suites.
// This is the only one that opens sockets, and forcing exit while a handle is
// still closing trips a libuv assertion on Windows —
// `!(handle->flags & UV_HANDLE_CLOSING)` — which prints after a clean 20/20 and
// turns a passing suite into a failing process. Setting the code lets node
// drain its handles and exit on its own.
process.exitCode = failed === 0 ? 0 : 1;
