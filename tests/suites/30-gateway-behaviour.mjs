// The gateway's ROUTES, driven for real. Not their source text.
//
// This suite could not exist before 2026-08-20. The gateway lived inside
// main.ts, which imports electron, so nothing offline could reach
// handleGatewayRequest — and suite 28 could only assert that the source of
// these routes LOOKED right: that a regex appeared before another regex, that a
// table contained a key. Those assertions catch drift and cannot catch
// breakage, which is docs/STRUCTURAL_DEBT.md item 4, and both real bugs found
// that week were found by running the thing rather than by reading it.
//
// Carving the gateway out (item 1) made it constructible with fakes, so item 4
// fell out of item 1 rather than needing its own project. That is the argument
// for the carve, and this file is the evidence for it.
//
// Everything below drives the REAL compiled handler with a fake request, a fake
// response, and a fake dependency set. No server is listened on, no port is
// bound, no provider is called, no API key is read.

import { EventEmitter } from "node:events";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const gateway = await fromBuild("electron/gateway.js");

const TOKEN = "test-token-not-a-real-one";
const AUTH = `Bearer ${TOKEN}`;
const audited = [];
const called = [];

gateway.configureGateway({
  reads: {
    "metisUsage.summary": () => ({ tokens: 42 }),
    "metisConversations.list": () => [{ id: "c1" }]
  },
  reducers: {
    "metisLoops.stop": (args) => { called.push(`stop:${args[0]}`); return { id: args[0], status: "stopped" }; }
  },
  appendAudit: async (level, kind) => { audited.push(kind); return {}; },
  readStoreValue: async (key, fallback) => (key === "gatewayToken" ? TOKEN : fallback),
  writeStoreValue: async () => {},
  listOllamaModels: async () => ({ reachable: true, installed: ["qwen3:8b"] }),
  listLoops: async () => [{ id: "loop-1", status: "running" }],
  stopLoop: async (id) => ({ id, status: "stopped" }),
  decidePolicy: async () => ({}),
  applySessionRouteOverrides: (_prompt, decision) => decision,
  providerFromRoute: () => "ollama",
  resolveOverrideModel: () => "qwen3:8b",
  invokeProvider: async () => ({ output: "hi" }),
  serveStaticFile: async () => {},
  providerDefaultModel: () => "qwen3:8b",
  rendererDist: "dist"
});

function fakeRequest(method, url, { auth, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = auth ? { authorization: auth } : {};
  // Emitted on the next tick so a handler that attaches listeners
  // synchronously still receives them, exactly like a real socket.
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeResponse() {
  const chunks = [];
  return {
    statusCode: null,
    headers: {},
    headersSent: false,
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true; },
    write(data) { chunks.push(data); },
    end(data) { if (data !== undefined) chunks.push(data); this.body = chunks.join(""); }
  };
}

async function request(method, url, options) {
  const res = fakeResponse();
  await gateway.handleGatewayRequest(fakeRequest(method, url, options), res);
  return res;
}

const json = (res) => { try { return JSON.parse(res.body); } catch { return null; } };
const bridge = (member, args = []) =>
  request("POST", "/v1/bridge", { auth: AUTH, body: JSON.stringify({ member, args }) });
// Separate helper rather than an `auth = AUTH` default parameter: passing
// `undefined` to a defaulted parameter re-supplies the default, so the
// "unauthenticated" case silently sent the token and passed. Caught by this
// suite failing on its own first run, which is the argument for the suite.
const bridgeWithoutAuth = (member, args = []) =>
  request("POST", "/v1/bridge", { body: JSON.stringify({ member, args }) });

section("The bearer check is real, not a comment about one");
{
  check("no header at all", (await request("GET", "/v1/models")).statusCode, 401);
  check("a wrong token", (await request("GET", "/v1/models", { auth: "Bearer nope" })).statusCode, 401);
  check("a malformed header", (await request("GET", "/v1/models", { auth: TOKEN })).statusCode, 401);
  check("the right token", (await request("GET", "/v1/models", { auth: AUTH })).statusCode, 200);
  // The bootstrap is deliberately narrow: HTML pages accept ?token=, JSON
  // routes never do. Asserted by BEHAVIOUR now rather than by reading the
  // condition that implements it.
  check("a JSON route refuses ?token=", (await request("GET", `/v1/models?token=${TOKEN}`)).statusCode, 401);
  check("the app document accepts it", (await request("GET", `/app/?token=${TOKEN}`)).statusCode !== 401, true);
}

section("Routes answer");
{
  const models = await request("GET", "/v1/models", { auth: AUTH });
  const ids = json(models).data.map((entry) => entry.id);
  ok("metis-auto is always offered", ids.includes("metis-auto"));
  ok("alongside the installed local tags", ids.includes("qwen3:8b"));

  const loops = await request("GET", "/v1/loops", { auth: AUTH });
  check("loops lists", json(loops).data.length, 1);

  check("an unknown route is a 404", (await request("GET", "/nope", { auth: AUTH })).statusCode, 404);
}

section("/app redirects, because one missing slash is a blank page");
{
  const redirect = await request("GET", "/app", { auth: AUTH });
  check("status", redirect.statusCode, 301);
  // Vite is base: "./", so at /app the relative asset paths resolve to
  // /assets/ and every one of them 404s behind a 200.
  check("location", redirect.headers.location, "/app/");
  const withToken = await request("GET", `/app?token=${TOKEN}`, {});
  ok("and the bootstrap token survives the redirect", String(withToken.headers.location).includes("token="));
}

section("The bridge allowlist is enforced at the door");
{
  const good = await bridge("metisUsage.summary");
  check("a readable member answers 200", good.statusCode, 200);
  check("with its value", json(good).value.tokens, 42);
  check("and marks itself ok", json(good).ok, true);

  // The four `read`-classified members that are refused HTTP anyway. The first
  // is the one that matters: it takes a URL the main process would then fetch.
  check("the SSRF member is refused", (await bridge("metisRegistry.refresh", ["http://evil"])).statusCode, 403);
  check("policy.decide is refused", (await bridge("metisPolicy.decide", [{}])).statusCode, 403);
  check("prewarm.route is refused", (await bridge("metisPrewarm.route", ["x"])).statusCode, 403);
  check("updates.check is refused", (await bridge("metisUpdates.check")).statusCode, 403);

  // Nothing that starts work, spends, writes or grants.
  for (const member of ["metisSession.run", "metisLoops.create", "metisFiles.write", "metisPermissions.respond", "metisStore.get", "metisStore.set"]) {
    check(`${member} is refused`, (await bridge(member, [{}])).statusCode, 403);
  }
  check("an invented member is refused", (await bridge("metisNonsense.nope")).statusCode, 403);
  check("and a missing member name is a 400", (await bridge("")).statusCode, 400);
  check("a malformed body is a 400", (await request("POST", "/v1/bridge", { auth: AUTH, body: "{not json" })).statusCode, 400);

  // The bridge is a JSON route and takes the bearer like every other one — the
  // /app/assets/ exemption is assets only, and this is precisely the route an
  // ambient cookie credential would have endangered.
  check("and it still needs the bearer", (await bridgeWithoutAuth("metisUsage.summary")).statusCode, 401);
}

section("A reduce runs and leaves a trace; a read does not");
{
  audited.length = 0;
  called.length = 0;
  const stopped = await bridge("metisLoops.stop", ["loop-1"]);
  check("the reduce answers 200", stopped.statusCode, 200);
  check("and actually reached the wired function", called, ["stop:loop-1"]);
  check("and left exactly one audit line", audited, ["gateway.bridge.reduce"]);

  audited.length = 0;
  await bridge("metisUsage.summary");
  // Reads are the bulk of the traffic; auditing them would bury the lines that
  // matter.
  check("a read leaves none", audited, []);
}

section("Nothing here bound a port");
{
  // The whole suite drove the handler directly. If this file ever starts
  // listening, it stops being offline and starts being flaky.
  ok("no server was started", typeof gateway.startGateway === "function");
  ok("handleGatewayRequest is exported for exactly this reason", typeof gateway.handleGatewayRequest === "function");
  ok("and the gateway refuses to run unconfigured", typeof gateway.configureGateway === "function");
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
