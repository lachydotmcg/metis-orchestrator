// The browser client: the desktop renderer served over the gateway at /app/.
//
// Two things are being guarded, and only one of them is the routing.
//
// The routing half is ordinary: path policy, the trailing-slash redirect, the
// bootstrap injection. Cheap to get right, cheap to assert.
//
// The other half is the reason the suite exists. Serving this bundle with no
// bridge lands it on a benchmark wizard whose "run" is a setInterval over four
// hardcoded strings and whose GPU table is a constant — so with nothing behind
// it, it completes anyway, unlocks the whole navigation, and recommends local
// models for a graphics card it never read. That is not an empty panel, it is
// a panel that LIES, and it is the exact failure this repo already shipped once
// (0401547: a surface documented as reachable while it sat in
// V1_HIDDEN_SETTINGS, with a guard that asserted it RENDERED). So the cut is
// asserted here, and asserted as a PAIR: hiding the tab without unlocking the
// gate bounces every navigation to a tab that no longer renders, which is a
// dead app, and unlocking the gate without hiding the tab is the lie. Either
// one alone passes a naive check and ships a broken build.
//
// App.tsx cannot be imported (JSX, and it is the renderer bundle), so those
// assertions read the SOURCE. That is the same call 12-doc-honesty makes.
//
// Offline: no provider is called, no server is started, no API key is read.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { BRIDGE_CHANNELS, bridgeChannelsHttpReadable, bridgeMemberIsHttpReadable, bridgeChannelsLiveForRemote, bridgeChannelsHttpReducible, bridgeMemberIsHttpReducible } =
  await fromBuild("shared/bridge-manifest.js");

const {
  gatewayBridgeShim,
  GATEWAY_APP_PREFIX,
  gatewayAppAssetPath,
  gatewayAppShell,
  gatewayAppMissingBuildPage,
  isGatewayAppDocument,
  isGatewayAppRedirect
} = await fromBuild("electron/gateway-app-shell.js");

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const main = read("src", "electron", "main.ts");
const app = read("src", "renderer", "ui", "App.tsx");

section("The mount does not displace anything already shipped");
{
  check("mounted at /app", GATEWAY_APP_PREFIX, "/app");
  // "/" is the loops page and has been since the phone surface shipped.
  ok('"/" is not claimed by the app shell', !isGatewayAppDocument("/") && !isGatewayAppRedirect("/"));
  ok('"/loops" is not claimed either', !isGatewayAppDocument("/loops") && !isGatewayAppRedirect("/loops"));
  ok("the document is /app/", isGatewayAppDocument("/app/"));
  ok("and /app/index.html reaches the same document", isGatewayAppDocument("/app/index.html"));
  // One missing slash is the difference between the app and a blank page:
  // Vite is `base: "./"`, so at /app the relative asset paths resolve to
  // /assets/ — a prefix this gateway does not serve.
  ok("/app redirects", isGatewayAppRedirect("/app"));
  ok("/app/ does not redirect", !isGatewayAppRedirect("/app/"));
}

section("Only the asset directory is public, and it is scoped tightly");
{
  check("an asset maps into dist/", gatewayAppAssetPath("/app/assets/index-abc123.js"), "/assets/index-abc123.js");
  check("nested assets too", gatewayAppAssetPath("/app/assets/providers/qwen.png"), "/assets/providers/qwen.png");
  // The document is NOT public: it carries the bootstrap token, and it is the
  // one /app/ path that still takes the bearer check.
  check("the document is not an asset", gatewayAppAssetPath("/app/"), null);
  check("nor is index.html", gatewayAppAssetPath("/app/index.html"), null);
  // Scoped to /app/assets/ rather than "anything under /app/ that is not the
  // document", so a file appearing at the dist ROOT later is not served by
  // default. This is the assertion that keeps that decision from eroding.
  check("a dist-root file is not public", gatewayAppAssetPath("/app/.env"), null);
  check("nor a root manifest", gatewayAppAssetPath("/app/manifest.json"), null);
  check("nothing outside the mount", gatewayAppAssetPath("/assets/index.js"), null);
  check("and no prefix confusion", gatewayAppAssetPath("/application/assets/x.js"), null);
  // Found by this suite, not predicted by it: dist/ is not purely build output,
  // because Vite copies public/* in verbatim and a OneDrive checkout had
  // Explorer metadata sitting in the screenshots folder.
  check("Explorer metadata is not served", gatewayAppAssetPath("/app/assets/readmeimages/desktop.ini"), null);
  check("nor is Thumbs.db", gatewayAppAssetPath("/app/assets/Thumbs.db"), null);
  check("nor a dotfile", gatewayAppAssetPath("/app/assets/.env"), null);
  // Containment itself is serveStaticFile's job (isPathInside + realpath); this
  // only checks the policy layer does not hand it an obviously hostile path
  // unexamined. A traversal that reaches here still dies one layer down.
  ok("a traversal is still only a path, handed to the guarded reader", gatewayAppAssetPath("/app/assets/../../secret") !== undefined);
}

section("The client flag is set before the bundle can read it");
{
  const html = '<!doctype html>\n<html><head>\n<script type="module" crossorigin src="./assets/index-x.js"></script>\n</head><body></body></html>';
  const shell = gatewayAppShell(html, "deadbeef");
  ok("a shell is produced", typeof shell === "string");
  ok("the flag is set", shell.includes('window.__METIS_CLIENT__ = "browser"'));
  // ORDER IS THE WHOLE POINT. Vite emits type="module", which is deferred and
  // runs after parsing; a classic inline script runs the instant the parser
  // reaches it. Injected after <head> the flag is settled before a line of
  // React executes, which is what lets App.tsx read it at MODULE scope. Injected
  // after the bundle it would be too late and every browser cut would silently
  // not apply — a passing build that ships the lie.
  ok("and it is set BEFORE the module bundle", shell.indexOf("__METIS_CLIENT__") < shell.indexOf('type="module"'));
  ok("the token is bootstrapped out of the URL", shell.includes('searchParams.delete("token")'));
  ok("and stashed for the fetches that come next", shell.includes("metis-gateway-token"));
  ok("the original markup survives", shell.includes('src="./assets/index-x.js"'));

  // A build output this function does not recognise is one it should not guess
  // about — null lets the caller say so instead of serving a page whose flag
  // never ran, which would look identical to a working one until a surface lied.
  check("no <head> means no shell", gatewayAppShell("<html><body>hi</body></html>", "t"), null);
}

section("The token cannot break out of the script element");
{
  // JSON.stringify escapes quotes but leaves "/" alone, so a value containing
  // </script> closes the ELEMENT — the HTML parser gets there before the JS
  // parser does. Same lesson the loops page learned; the helper is shared, and
  // this asserts the sharing actually happened.
  const nasty = '</script><script>window.pwned=1</script>';
  const shell = gatewayAppShell("<html><head></head><body></body></html>", nasty);
  ok("no raw </script> from the token", !shell.includes("</script><script>window.pwned"));
  ok("the bracket is unicode-escaped", shell.includes("\\u003c/script"));
}

section("The missing-build page is a diagnosis, not a 404");
{
  const page = gatewayAppMissingBuildPage();
  // npm run dev serves the renderer from Vite and never writes dist/, so this
  // is the state a developer hits most often. "Not found" would send them
  // looking for a routing bug that is not there.
  ok("it names the build command", page.includes("npm run build"));
  ok("it names the directory", page.includes("dist/"));
  ok("it explains why dev mode differs", page.includes("npm run dev"));
}

section("The REAL build's own asset URLs are servable by the REAL policy");
{
  // Everything above uses invented paths. This closes the loop on the actual
  // artifact: take the index.html Vite just wrote, shell it exactly as the
  // gateway does, pull the URLs the browser will really request, resolve them
  // against /app/ the way a browser resolves a relative href, and hand each one
  // to the policy that decides whether it gets served. A hash change, a base
  // change, or an output-directory change breaks this and nothing else.
  const indexPath = join(process.cwd(), "dist", "index.html");
  if (existsSync(indexPath)) {
    const shell = gatewayAppShell(readFileSync(indexPath, "utf8"), "tok");
    ok("the real index.html shells cleanly", typeof shell === "string");
    const refs = [...shell.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((ref) => !ref.startsWith("http") && !ref.startsWith("data:"));
    ok(`the build references ${refs.length} local files`, refs.length >= 2);
    const unresolvable = refs
      .map((ref) => new URL(ref, "http://127.0.0.1/app/").pathname)
      .filter((path) => gatewayAppAssetPath(path) === null);
    // If `base` ever stops being "./" these come out as /assets/... and every
    // one of them is refused — a blank page served with a 200.
    check("every one resolves under /app/ and is servable", unresolvable, []);
    const onDisk = refs
      .map((ref) => new URL(ref, "http://127.0.0.1/app/").pathname)
      .filter((path) => !existsSync(join(process.cwd(), "dist", gatewayAppAssetPath(path) ?? "")));
    check("and every one exists on disk where the gateway will look", onDisk, []);
  } else {
    ok("dist/index.html absent, real-build check skipped (run npm run build)", true);
  }
}

section("main.ts serves assets BEFORE the bearer check, on purpose and only there");
{
  const authAt = main.indexOf("Missing or invalid bearer token.");
  const assetAt = main.indexOf("gatewayAppAssetPath(url.pathname)");
  ok("both the auth check and the asset branch exist", authAt > 0 && assetAt > 0);
  // A <script src> cannot carry an Authorization header. If this branch ever
  // moves below the bearer check, /app/ returns 200 and then twelve 401s — a
  // blank page with a green HTML response, which is the single most confusing
  // failure this surface can have.
  ok("the asset branch runs first", assetAt < authAt);
  // And it must be the ONLY thing that does. An ambient credential (a cookie)
  // was rejected precisely because it would hand every other page in the
  // browser a CSRF path to the route that spends money; the equivalent mistake
  // here is a second pre-auth branch.
  const preAuth = main.slice(main.indexOf("async function handleGatewayRequest"), authAt);
  const returns = [...preAuth.matchAll(/\n {6}return;/g)].length;
  ok(`exactly one pre-auth early return, found ${returns}`, returns === 1);
  ok("assets are read through the guarded reader, not a bare readFile", preAuth.includes("serveStaticFile("));
  ok("the gateway still binds loopback only", main.includes('server.listen(configuredPort, "127.0.0.1"'));
}

section("Every extension the real build emits has a real MIME type");
{
  // Not a hardcoded list: walk dist/ if it exists and demand a type for what is
  // ACTUALLY there. A stylesheet or module served as octet-stream is refused
  // outright by strict MIME checking, so this list is load-bearing for the
  // browser client in a way it never was for the local static preview.
  const distAssets = join(process.cwd(), "dist", "assets");
  const typed = new Set(
    [...main.matchAll(/ext === "(\.[a-z0-9]+)"/g)].map((match) => match[1])
  );
  for (const required of [".js", ".css", ".html", ".png", ".svg", ".woff2", ".ico"]) {
    ok(`${required} has a MIME type`, typed.has(required));
  }
  if (existsSync(distAssets)) {
    const walk = (dir, prefix) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
      );
    const everyFile = walk(distAssets, "/app/assets/");
    // Run the REAL policy over the REAL tree rather than a list of extensions
    // someone typed. This is how the desktop.ini was found: Vite copies
    // `public/*` in verbatim, and a OneDrive checkout had Explorer metadata
    // sitting in the screenshots folder, which the first version of this branch
    // would have served.
    const served = everyFile.filter((path) => gatewayAppAssetPath(path) !== null);
    ok(`${served.length} of ${everyFile.length} files in dist/assets are servable`, served.length > 0);
    const untyped = [...new Set(served.map((path) => extname(path).toLowerCase()))]
      .filter((ext) => ext && !typed.has(ext))
      .sort();
    check("nothing servable falls through to octet-stream", untyped, []);
    const refused = everyFile.filter((path) => gatewayAppAssetPath(path) === null);
    ok(
      `OS metadata is refused, not served (${refused.length} file${refused.length === 1 ? "" : "s"})`,
      refused.every((path) => /desktop\.ini$|thumbs\.db$|\/\.[^/]+$/i.test(path))
    );
  } else {
    ok("dist/assets absent, extension sweep skipped (run npm run build)", true);
  }
}

section("The benchmark simulation cannot run in the browser client");
{
  ok("the cut set exists", app.includes("const BROWSER_HIDDEN_NAV"));
  const set = /const BROWSER_HIDDEN_NAV = new Set<NavKey>\(\[([^\]]*)\]\)/.exec(app);
  ok("and it names benchmark", Boolean(set) && set[1].includes('"benchmark"'));
  ok("isNavVisible honours it", /function isNavVisible[\s\S]{0,240}BROWSER_HIDDEN_NAV\.has\(key\)/.test(app));

  // THE ASSERTION THAT WAS MISSING, and the reason this comment is long.
  //
  // The first version of this suite checked only that isNavVisible honours the
  // set — which was true, and passed, while the Benchmark button sat in the
  // sidebar exactly as before. The four v1 nav items are rendered
  // UNCONDITIONALLY (they are the ones that always ship, so nobody wrapped
  // them), so the predicate had no say over the only control that reaches the
  // wizard. Loading the real bundle in a real browser found it in one call;
  // reading the source did not, twice.
  //
  // Same shape as 0401547, where a panel was documented as reachable while it
  // sat in V1_HIDDEN_SETTINGS and the guard asserted it RENDERED. A predicate
  // returning false is not the same fact as a surface being unreachable, so
  // this asserts the BUTTON.
  const navButton = /<NavButton[^\n]*label="Benchmark"/.exec(app);
  ok("the Benchmark nav button exists", Boolean(navButton));
  ok(
    "and it is behind isNavVisible, not rendered unconditionally",
    /isNavVisible\("benchmark"\) \? \(\s*<NavButton[^\n]*label="Benchmark"/.test(app)
  );
  // Belt and braces at the mount site: even a caller that sets activeNav
  // directly cannot bring the wizard back.
  ok(
    "and the workspace itself will not mount when the key is cut",
    /activeNav === "benchmark" && isNavVisible\("benchmark"\) \?/.test(app)
  );

  // THE PAIR. Hiding the tab while the gate stays armed sends every navigation
  // back to a tab that no longer renders — an app you cannot use at all. Both
  // halves, or neither.
  ok(
    "and the first-run gate is unlocked in the same client",
    /benchmarkGateLocked = METIS_BROWSER_CLIENT \? false :/.test(app)
  );
  ok(
    "the nav-forcing effect skips the browser client",
    /if \(METIS_BROWSER_CLIENT\) return;[\s\S]{0,120}setActiveNav\("benchmark"\)/.test(app)
  );
  ok(
    "and it does not LAND on benchmark either",
    /useState<NavKey>\(METIS_BROWSER_CLIENT \? "orchestration" : "benchmark"\)/.test(app)
  );
}

section("The client flag is asked the right question");
{
  // Not `!window.metisSession`: a desktop window with a broken preload fails
  // that test too, and the two cases want opposite handling — a broken preload
  // is a bug to surface, a browser with no bridge is the expected state.
  ok("it reads who is serving the page", app.includes('window.__METIS_CLIENT__ === "browser"'));
  ok("it is a module-level constant, so it cannot change mid-render", /^const METIS_BROWSER_CLIENT =/m.test(app));
  ok("the type is declared", read("src", "renderer", "global.d.ts").includes("__METIS_CLIENT__?: \"browser\""));
}

section("The preview says it is a preview");
{
  // The renderer draws the real UI over a bridge that is not there. Without a
  // notice that reads as a broken app, and every empty panel is a bug report.
  ok("the strip renders only in the browser client", /METIS_BROWSER_CLIENT \? \(\s*<div className="browser-preview-strip"/.test(app));
  // The wording has to track what is actually wired. It said "no models, no
  // conversations" while that was true; now that both load, the honest claim is
  // read-only. A strip that undersells is a lie in the other direction, and a
  // stale one is how a page ends up describing a version of itself that no
  // longer exists.
  // Scoped to the RENDERED element, not the file: the comment above it quotes
  // the old wording to explain why it changed, and a whole-file match reads
  // that comment as the live text. Caught by this assertion failing on its
  // own explanation.
  const strip = /<div className="browser-preview-strip"[\s\S]*?<\/div>/.exec(app);
  ok("the strip's text is found", Boolean(strip));
  ok("it says the client is read-only", /read-only/i.test(strip[0]));
  ok("and names what still needs the desktop", /send a prompt, write a file or start a run/.test(strip[0]));
  ok("and no longer claims nothing loads", !/no models, no conversations/.test(strip[0]));
  ok("the style exists", read("src", "renderer", "styles.css").includes(".browser-preview-strip"));
}

section("What gets an HTTP route is the manifest's decision, not the route file's");
{
  const readable = bridgeChannelsHttpReadable();
  check("26 members read over HTTP", readable.length, 26);
  // `read` alone returns 35. The gap is five SUBSCRIBE channels — push, not
  // request/response — plus the four below. Pinned so a reclassification has to
  // be looked at.
  const safe = BRIDGE_CHANNELS.filter((entry) => entry.exposure === "read");
  check("out of 35 classified read", safe.length, 35);
  ok("no subscribe channel is HTTP-readable", readable.every((entry) => entry.kind === "invoke"));
  ok("and every readable one is classified read", readable.every((entry) => entry.exposure === "read"));

  // THE FOUR, BY NAME. `read` was assigned against the DESKTOP threat model —
  // "this only reads, so the renderer may have it" — and these pass that test
  // while failing a different one once the caller is remote. Serving
  // bridgeChannelsSafeToServe() mechanically would have shipped the first of
  // them, which is a straight SSRF primitive.
  for (const member of ["metisRegistry.refresh", "metisPolicy.decide", "metisPrewarm.route", "metisUpdates.check"]) {
    ok(`"${member}" is classified read but refused over HTTP`, !bridgeMemberIsHttpReadable(member));
  }
  const excluded = BRIDGE_CHANNELS.filter((entry) => entry.noHttp);
  check("exactly four exclusions", excluded.length, 4);
  ok("and every one says why", excluded.every((entry) => typeof entry.noHttp === "string" && entry.noHttp.length > 30));
  // The one that matters most, spelled out: it sits one line under `fetchUrl`,
  // which is already `decision` for the same capability.
  ok(
    "the SSRF reason names the mechanism, not just the verdict",
    /sourceUrl/.test(BRIDGE_CHANNELS.find((entry) => entry.channel === "metis-registry:refresh")?.noHttp ?? "")
  );

  // Nothing that writes, spends, grants or touches the host is reachable.
  for (const member of [
    "metisStore.get",
    "metisStore.set",
    "metisGateway.getStatus",
    "metisSession.run",
    "metisLoops.create",
    "metisFiles.write",
    "metisPermissions.respond",
    "metisRegistry.install"
  ]) {
    ok(`"${member}" is not readable over HTTP`, !bridgeMemberIsHttpReadable(member));
  }
}

section("The wiring matches the policy, in BOTH directions");
{
  // A member wired but not permitted is a hole; a member permitted but not
  // wired is a dead route that 501s. Neither is visible by reading one file.
  const block = /const GATEWAY_BRIDGE_READS[\s\S]*?\n};/.exec(main);
  ok("the dispatch table is found", Boolean(block));
  const wired = [...block[0].matchAll(/"([a-zA-Z]+\.[a-zA-Z]+)":/g)].map((m) => m[1]).sort();
  const permitted = bridgeChannelsHttpReadable().map((entry) => `${entry.namespace}.${entry.method}`).sort();
  check("every permitted member is wired", permitted.filter((m) => !wired.includes(m)), []);
  check("and nothing is wired that is not permitted", wired.filter((m) => !permitted.includes(m)), []);
  // The manifest is checked BEFORE the table is indexed, so a member left in
  // the table after being reclassified is refused rather than quietly served.
  const handler = /async function handleGatewayBridgeRead[\s\S]*?\n}/.exec(main);
  ok("the handler exists", Boolean(handler));
  ok(
    "the manifest check runs before the table lookup",
    handler[0].indexOf("bridgeMemberIsHttpReadable") < handler[0].indexOf("GATEWAY_BRIDGE_READS[member]")
  );
  ok("undefined is collapsed to null for JSON", /value === undefined \? null : value/.test(handler[0]));
  ok("the body reader is the shared one, with its cap", /readGatewayBody\(req, GATEWAY_MAX_BODY_BYTES\)/.test(handler[0]));

  // The read route is a JSON route and takes the bearer check like every other
  // one. The asset exemption is assets only — this is precisely the route that
  // would make an ambient cookie credential dangerous.
  const authAt = main.indexOf("Missing or invalid bearer token.");
  ok("/v1/bridge is routed after the bearer check", main.indexOf('url.pathname === "/v1/bridge"') > authAt);
}

section("The shim tells 'partly here' apart from 'not here'");
{
  const shim = gatewayBridgeShim();
  const table = JSON.parse(/var NS = (\{[\s\S]*?\});/.exec(shim)[1]);

  ok("readable members fetch", table.metisUsage?.summary === "read");
  ok("and so do the ones panels need most", table.metisConversations?.list === "read" && table.metisCatalog?.models === "read");

  // The subtle one. The renderer guards on Boolean(window.metisX), so defining
  // a namespace makes every guard in it pass. If the unreadable members were
  // absent, the guard would wave the code through and it would die on
  // "undefined is not a function" — a stack trace instead of a sentence.
  ok("unreadable members in a served namespace are DEFINED, not missing", table.metisUsage?.setLimits === "no");
  ok("and they reject rather than no-op", /needs the desktop app/.test(shim));
  ok("with the member naming itself in the message", /member \+ " needs the desktop app/.test(shim));

  // A namespace with nothing readable is left undefined entirely, so its panels
  // take the existing not-present path and render nothing rather than a row of
  // errors. "Not here" and "partly here" are different facts.
  ok("metisGateway is absent entirely", table.metisGateway === undefined);
  ok("metisStore is absent entirely", table.metisStore === undefined);
  ok("metisFiles is absent entirely", table.metisFiles === undefined);
  // Every namespace present must have earned it.
  ok(
    "every served namespace has at least one readable member",
    Object.values(table).every((members) => Object.values(members).includes("read"))
  );
  // And nothing refused is reachable through a namespace that IS served.
  ok("the SSRF member is present-but-rejecting, not readable", table.metisRegistry?.refresh === "no");
  ok("metisRegistry.list beside it still reads", table.metisRegistry?.list === "read");

  // ONE of the five subscribe channels can carry anything to a remote client,
  // and the difference is not the transport. Four are `event.sender.send(...)`
  // replies addressed to whoever invoked something, and every one of their
  // producers is `decision` — so a browser client cannot cause a single event,
  // and a stream for them would carry nothing forever. Only metis-loops:changed
  // is ambient (broadcastLoopsChanged to every window, no payload).
  ok("the ambient one is a real subscription", (table.metisLoops?.onChanged ?? "").startsWith("live:"));
  ok("and it polls the read that answers it", table.metisLoops?.onChanged === "live:metisLoops.list");
  for (const [ns, method] of [
    ["metisOllama", "onPullProgress"],
    ["metisSession", "runStream"]
  ]) {
    const verdict = table[ns]?.[method];
    ok(`${ns}.${method} is not pretended to be live`, verdict === "inert" || verdict === "no");
  }
  ok("inert subscriptions still hand back a real unsubscribe", /function inertSubscription\(\) \{ return function \(\) \{\}; \}/.test(shim));
  // The first poll records without firing: firing on it would report a change
  // that is really just the subscription starting.
  ok("the first poll does not fire a spurious change", /if \(last !== null && signature !== last\)/.test(shim));
  ok("and the unsubscribe actually stops the timer", /stopped = true; if \(timer\) clearTimeout\(timer\)/.test(shim));

  // runStream owns two channels, invoke and subscribe, and the INVOKE half must
  // win. Caught by this assertion: adding the live/inert split made the
  // subscribe half win, which would have defined runStream as a no-op
  // subscription — so a caller that thinks it started a run gets silence
  // instead of a rejection. A silent no-op on the member that spends money is
  // the worst available outcome.
  ok("a two-channel member is not downgraded by its subscribe half", table.metisSession?.runStream === "no");
  ok("so calling it rejects rather than silently doing nothing", /needs the desktop app/.test(shim));
}

section("The three members that can only make the machine do LESS are reachable");
{
  // Not a new judgement: POST /v1/loops/:id/stop has shipped since the phone
  // page, with the argument written above it — watching and stopping are both
  // safe in the way that matters, one being a read and the other only ever
  // reducing what the machine is doing. `reduce` is the class that argument
  // describes. What made wiring it worth doing: the browser client rendered a
  // stop button that REJECTED, while the capability behind it was live one
  // route over. Logic shipped with no way to reach it.
  const reducible = bridgeChannelsHttpReducible();
  check("three of them", reducible.length, 3);
  check(
    "and they are the ones the argument covers",
    reducible.map((entry) => `${entry.namespace}.${entry.method}`).sort(),
    ["metisLoops.stop", "metisPermissions.revoke", "metisSession.cancel"]
  );
  ok("every one is classified reduce", reducible.every((entry) => entry.exposure === "reduce"));

  // The boundary. Each of these sits beside a reduce member in the same
  // namespace and must NOT come along with it.
  for (const member of [
    "metisLoops.delete",
    "metisLoops.create",
    "metisSession.run",
    "metisSession.runStream",
    "metisPermissions.respond",
    "metisPermissions.request"
  ]) {
    ok(`"${member}" is not reducible`, !bridgeMemberIsHttpReducible(member));
  }
  // And the two questions stay separate: a read must never satisfy the reduce
  // check or the other way round.
  ok("no member is both readable and reducible", !bridgeChannelsHttpReadable().some((entry) =>
    bridgeMemberIsHttpReducible(`${entry.namespace}.${entry.method}`)));

  // Separate dispatch tables in main.ts, for the same reason: a read that could
  // mutate is one careless merge away when both live in one map.
  const readsTable = /const GATEWAY_BRIDGE_READS[\s\S]*?\n};/.exec(main)[0];
  const reduceTable = /const GATEWAY_BRIDGE_REDUCERS[\s\S]*?\n};/.exec(main);
  ok("the reducer table exists and is its own map", Boolean(reduceTable));
  const wiredReducers = [...reduceTable[0].matchAll(/"([a-zA-Z]+\.[a-zA-Z]+)":/g)].map((m) => m[1]).sort();
  check("wired reducers match the manifest", wiredReducers, ["metisLoops.stop", "metisPermissions.revoke", "metisSession.cancel"]);
  ok("no reducer leaked into the reads table", !wiredReducers.some((m) => readsTable.includes(`"${m}"`)));

  const handler = /async function handleGatewayBridgeRead[\s\S]*?\n}/.exec(main)[0];
  ok("the handler asks the two questions separately", /bridgeMemberIsHttpReadable\(member\)/.test(handler) && /bridgeMemberIsHttpReducible\(member\)/.test(handler));
  // A reduce CHANGES what the machine is doing, so it leaves a trace. Reads are
  // not audited — they are the bulk of traffic and would bury the lines that matter.
  ok("a reduce is audited", /gateway\.bridge\.reduce/.test(handler));
  ok("and reads are not", !/appendAudit[\s\S]{0,120}gateway\.bridge\.read\b/.test(handler));

  // The shim calls them exactly like reads: identical on the wire, named apart
  // so the table says which members can change anything.
  const shimTable = JSON.parse(/var NS = (\{[\s\S]*?\});/.exec(gatewayBridgeShim())[1]);
  check("the stop button is live in the browser", shimTable.metisLoops?.stop, "reduce");
  check("cancel too", shimTable.metisSession?.cancel, "reduce");
  check("and revoke", shimTable.metisPermissions?.revoke, "reduce");
  check("while delete stays refused", shimTable.metisLoops?.delete, "no");
  check("and starting a run stays refused", shimTable.metisSession?.run, "no");
}

section("Refusing to stream is recorded as data, with a reason");
{
  const live = bridgeChannelsLiveForRemote();
  check("one of the five subscribe channels is live for a remote client", live.length, 1);
  check("and it is the ambient one", live[0].channel, "metis-loops:changed");
  const muted = BRIDGE_CHANNELS.filter((entry) => entry.noStream);
  check("the other four say why", muted.length, 4);
  ok("every reason is a reason, not a label", muted.every((entry) => entry.noStream.length > 40));
  // The reason must name the MECHANISM — that the producers are decision-class —
  // because "we did not build it" and "there is nothing to build" are different
  // facts and only one of them should stop somebody building it later.
  ok(
    "and names the producer class rather than just the verdict",
    muted.every((entry) => /decision/.test(entry.noStream))
  );
  ok("no noStream is set on a non-subscribe channel", muted.every((entry) => entry.kind === "subscribe"));

  ok("the shim runs before the bundle", gatewayAppShell("<html><head></head><body></body></html>", "t").indexOf("var NS =") > 0);
}

section("A thrown render cannot blank the page any more");
{
  // There was no error boundary anywhere in this renderer, so every
  // render-time throw unmounted the whole tree and left #root empty — no
  // sidebar, no message, nothing. Found by serving a deliberately wrong shape:
  // metisPulse.feed returning null destroyed a non-null fallback
  // (useState(FALLBACK_PULSE) then a blind .then(setPulse)) and the next
  // pulse.updated threw during the TITLEBAR render.
  //
  // The titlebar is shell, not panel, which is why the boundary wraps App
  // rather than each workspace — a per-workspace boundary would have caught
  // nothing. Verified in a browser against the real bundle: the same response
  // that gave rootChildren 0 now renders the recovery screen.
  const boundary = read("src", "renderer", "ui", "ErrorBoundary.tsx");
  const entry = read("src", "renderer", "main.tsx");

  ok("it is a real boundary, not a try/catch pretending", /static getDerivedStateFromError/.test(boundary));
  ok("and it reports rather than only swallowing", /componentDidCatch/.test(boundary));
  ok("it wraps App at the root", /<ErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/ErrorBoundary>/.test(entry));
  // Outside StrictMode: it has to survive whatever it is catching, so it sits
  // above everything that could throw.
  ok("outside StrictMode, so it is above what it catches", entry.indexOf("<ErrorBoundary>") < entry.indexOf("<React.StrictMode>"));

  // This is the one component that must render when the rest could not, so it
  // depends on nothing — no stylesheet class that may not have loaded, no
  // store, no bridge. A recovery screen that can itself fail is not one.
  ok("it is styled inline, depending on no stylesheet", /style=\{\{/.test(boundary));
  ok("it imports no bridge, store or context", !/window\.metis[A-Z]/.test(boundary) && !/useAppStoreState/.test(boundary));
  ok("it offers a way out", /window\.location\.reload\(\)/.test(boundary));
  ok("it shows the actual error", /error\.message/.test(boundary));
  // The browser client's most likely cause is a wrong-shaped gateway reply, and
  // saying so points at the right layer. On the desktop that would be wrong, so
  // the two messages differ.
  ok("it names the likely cause in the browser client", /__METIS_CLIENT__ === "browser"/.test(boundary));
  ok("and says the desktop app is unaffected", /desktop app is unaffected/.test(boundary));
  ok("while the desktop message is about your work being safe", /not lost/.test(boundary));
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
