/** Serving the DESKTOP renderer over the gateway, at /app/.
 *
 *  The loops page next door is a second, tiny client written by hand. This is
 *  the opposite bet: the same Vite bundle Electron loads, handed to a browser
 *  unchanged. Nothing is rewritten and nothing is forked, so the browser can
 *  never drift from the desktop — it is byte-for-byte the same build.
 *
 *  What that buys and what it does not:
 *
 *  The bundle renders, and it READS. It does not write and it does not run
 *  anything. Every component calls `window.metisX` — the Electron preload
 *  bridge — directly, and over HTTP there is no preload, so `gatewayBridgeShim()`
 *  rebuilds those namespaces out of `fetch`.
 *
 *  What it does NOT do is proxy the bridge, and the reason is worth keeping:
 *  `installIpcSenderGuard` authenticates frame TOPOLOGY
 *  (`senderFrame.parent !== null`), not identity, so an HTTP caller has no
 *  `senderFrame` and no handler inherits any protection once reached over HTTP.
 *  There is no transport swap that preserves the guarantee. So the routes call
 *  the same named functions the handlers call — `readConversations()`,
 *  `computeUsageSummary()` — and carry their own authorization, per member,
 *  against the classification in `shared/bridge-manifest.ts`.
 *
 *  26 members read. The rest of the surface is honest about being absent: see
 *  `gatewayBridgeShim()` for how a namespace that is partly there differs from
 *  one that is not there at all. The renderer is told which client it is in
 *  (`__METIS_CLIENT__`) so it can also cut the one surface that would LIE
 *  rather than sit empty — the benchmark wizard, whose "run" is a setInterval
 *  over hardcoded strings and which therefore passes, unlocks the whole
 *  navigation, and recommends models to a machine it never looked at.
 *
 *  AUTH, and why the bundle is public.
 *
 *  A `<script src>` cannot carry an Authorization header. The loops page got
 *  around that with a `?token=` bootstrap, but a bootstrap only helps the
 *  document — the twelve requests the document then makes for its own JS, CSS
 *  and PNGs have no way to be authorized, and they would each take a bare 401
 *  while the HTML itself returned 200. The page would be blank.
 *
 *  Two ways out: set a cookie on the bootstrap, or stop pretending the bundle
 *  is a secret. A cookie is the worse one. It introduces an AMBIENT credential
 *  to a service that currently has none, which hands every other page in the
 *  browser a CSRF path to `POST /v1/chat/completions` — a route that spends
 *  real money. SameSite=Strict blocks that, but the whole reason the gateway is
 *  safe today is that it has no ambient credential to steal, and that is worth
 *  more than the alternative costs.
 *
 *  The alternative costs nothing, because the bundle is not a secret. It is the
 *  app's own compiled code, identical to the JavaScript inside the installer
 *  anyone can download from the releases page. It contains no key, no
 *  conversation, no file path and no user data of any kind. Serving it
 *  unauthenticated to another process on 127.0.0.1 discloses a public artifact.
 *  So: everything under /app/assets/ is served with no token, every JSON route
 *  keeps the exact bearer check it has today, and the gateway acquires no
 *  ambient credential.
 *
 *  The token on the /app/ DOCUMENT is therefore not protecting the bundle. It
 *  is the bootstrap — the only way the token reaches the page at all, and what
 *  the next stage's authorized fetches will use.
 */

import { scriptSafeJson } from "./gateway-loops-page.js";
import { BRIDGE_CHANNELS, bridgeMemberIsHttpReadable, bridgeMemberIsHttpReducible } from "../shared/bridge-manifest.js";

/** The mount point. Not `/` — that is already the loops page, and displacing a
 *  shipped surface to make room for an unfinished one is the wrong trade. */
export const GATEWAY_APP_PREFIX = "/app";

/** The one directory Vite emits. `dist/` holds exactly `index.html` and
 *  `assets/` — Vite copies `public/*` into the out dir root, so the repo's
 *  `public/assets/providers/*.png` land under `dist/assets/` too. Pinning the
 *  public branch to this prefix rather than "anything that is not the document"
 *  means a file that appears at the dist ROOT later (a sourcemap, a manifest,
 *  a stray `.env` copied by a misconfigured plugin) is NOT served by default. */
const ASSET_PREFIX = `${GATEWAY_APP_PREFIX}/assets/`;

/** The asset path relative to `dist/`, or null when this is not an /app/ asset
 *  request. Callers pass the result straight to `serveStaticFile`, which owns
 *  the containment checks (`isPathInside` plus a realpath pass for symlinks) —
 *  this function decides POLICY, that one enforces the boundary. */
export function gatewayAppAssetPath(pathname: string): string | null {
  if (!pathname.startsWith(ASSET_PREFIX)) return null;
  // `dist/` is not purely build output, which the suite found rather than
  // predicted: Vite copies `public/*` in verbatim, and on a OneDrive-synced
  // checkout that included a `desktop.ini` Explorer had written into the
  // screenshots folder. Nothing in it was sensitive, but it proves the shape of
  // the problem — whatever the OS drops into a copied directory gets served.
  // These files are never referenced by a bundle, so refusing them costs
  // nothing and stops the served tree from being whatever the filesystem
  // happens to contain.
  const name = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith(".") || name === "desktop.ini" || name === "thumbs.db") return null;
  return pathname.slice(GATEWAY_APP_PREFIX.length);
}

/** True for the bare `/app`, which must redirect to `/app/`.
 *
 *  Vite is configured `base: "./"`, so the built index.html asks for
 *  `./assets/index-<hash>.js`. Resolved against `/app/` that is
 *  `/app/assets/...` and correct; resolved against `/app` — no trailing slash —
 *  the last segment is treated as a FILE name and it becomes `/assets/...`,
 *  which this gateway does not serve. Same for the renderer's runtime-built
 *  paths (`"assets/providers/qwen.png"`, App.tsx). One missing slash is the
 *  difference between the app and a blank page with twelve 404s. */
export function isGatewayAppRedirect(pathname: string): boolean {
  return pathname === GATEWAY_APP_PREFIX;
}

/** True for the document itself. */
export function isGatewayAppDocument(pathname: string): boolean {
  return pathname === `${GATEWAY_APP_PREFIX}/` || pathname === `${GATEWAY_APP_PREFIX}/index.html`;
}

/** The bootstrap script, injected into the built index.html.
 *
 *  It must run BEFORE the bundle. Vite emits `<script type="module">`, which is
 *  deferred and executes after the document is parsed; a classic inline script
 *  executes the moment the parser reaches it. So injecting immediately after
 *  `<head>` guarantees `__METIS_CLIENT__` is settled before a single line of
 *  React runs, which is what lets the flag be read at MODULE scope in the
 *  renderer rather than plumbed through a provider. */
function bootstrapScript(token: string): string {
  return `
window.__METIS_CLIENT__ = "browser";
(function () {
  // Same bootstrap the loops page uses: the token arrives in the URL because a
  // link you type or scan cannot carry a header, and the page's first act is to
  // move it out of the address bar so it does not sit in history.
  var url = new URL(window.location.href);
  var fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try { sessionStorage.setItem("metis-gateway-token", fromUrl); } catch (e) {}
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search);
  }
  var injected = ${scriptSafeJson(token)};
  try { window.__METIS_GATEWAY_TOKEN__ = sessionStorage.getItem("metis-gateway-token") || injected; }
  catch (e) { window.__METIS_GATEWAY_TOKEN__ = injected; }
})();
${gatewayBridgeShim()}
`.trim();
}

/** Injects the bootstrap into the built index.html.
 *
 *  Returns null if `<head>` is absent rather than appending blindly — a build
 *  output this function does not recognise is a build output it should not be
 *  guessing about, and a caller that gets null can say so instead of serving a
 *  page whose flag never ran. */
export function gatewayAppShell(indexHtml: string, token: string): string | null {
  const head = /<head[^>]*>/i.exec(indexHtml);
  if (!head) return null;
  const at = head.index + head[0].length;
  return `${indexHtml.slice(0, at)}\n    <script>${bootstrapScript(token)}</script>${indexHtml.slice(at)}`;
}

/** Shown when `dist/` is missing — `npm run dev` runs the renderer from Vite on
 *  5177 and never writes `dist/`, so a developer hitting /app/ mid-dev-session
 *  gets a stale build or none at all. Saying which is kinder than a bare 404,
 *  and this is the only case where /app/ answers without the real bundle. */
export function gatewayAppMissingBuildPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Metis — no build</title>
<style>body{background:#0d0f14;color:#e6e8ee;font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh}
main{max-width:32rem;padding:2rem}code{background:#1a1d26;padding:.15rem .4rem;border-radius:4px}</style>
</head><body><main>
<h1>No renderer build to serve</h1>
<p>The gateway serves <code>dist/</code>, which Vite only writes on a real build.
<code>npm run dev</code> runs the renderer from its dev server instead and leaves
<code>dist/</code> stale or absent.</p>
<p>Run <code>npm run build</code>, then reload.</p>
</main></body></html>`;
}

/** The bridge shim: `window.metisX` objects that fetch instead of using IPC.
 *
 *  Generated from BRIDGE_CHANNELS rather than hand-written, so a channel added
 *  to the preload appears here automatically and a channel reclassified stops
 *  being reachable without anyone remembering to edit a second list. The
 *  renderer is not modified at all — it keeps calling `window.metisUsage.summary()`
 *  and neither knows nor cares that the call became an HTTP request.
 *
 *  Three kinds of member, and the distinction between them is the honesty of
 *  the whole client:
 *
 *  **Readable** members POST to `/v1/bridge` and return real data.
 *
 *  **Everything else in a namespace that has at least one readable member** is
 *  defined too, and REJECTS with a message naming itself. That is deliberate
 *  and it is the subtle part: the renderer guards on `Boolean(window.metisX)`,
 *  so defining a namespace makes every one of those guards pass. If the
 *  unreadable members were simply absent, the guard would wave the code through
 *  and it would die on `undefined is not a function` — a stack trace instead of
 *  a sentence. A rejecting promise is the honest version of "this needs the
 *  desktop app".
 *
 *  **Subscribe** members return a working unsubscribe and never fire, because
 *  push needs an event stream and that is the next slice. A subscription that
 *  never fires costs live updates, not correctness — the panel still renders
 *  what its initial read returned.
 *
 *  A namespace with NO readable member is left undefined entirely, so its
 *  panels take the existing not-present path and render nothing rather than a
 *  row of errors. "This area is not here" and "this area is partly here" are
 *  different facts and the client tells them apart.
 */
/** What the shim does with one member.
 *
 *  `read`   — POST /v1/bridge and resolve the value.
 *  `reduce` — the same call, for the three members that can only ever make the
 *             machine do LESS (stop a loop, cancel a run, revoke a grant).
 *             Identical on the wire; named apart so the table says which
 *             members can change anything.
 *  `live:X` — a real subscription, polling read member X and firing on change.
 *  `inert`  — a subscription that returns a working unsubscribe and never fires,
 *             because nothing a browser client is allowed to do can produce an
 *             event on it. Distinct from `live` on purpose: "nothing to build"
 *             is a different fact from "not built yet".
 *  `no`     — reject, naming the member. */
type ShimMemberKind = "read" | "reduce" | "no" | "inert" | `live:${string}`;

export function gatewayBridgeShim(): string {
  const namespaces = new Map<string, Record<string, ShimMemberKind>>();
  for (const entry of BRIDGE_CHANNELS) {
    const members = namespaces.get(entry.namespace) ?? {};
    const member = `${entry.namespace}.${entry.method}`;
    // runStream owns two channels; the invoke half decides, so never let the
    // subscribe half overwrite a verdict already recorded for the same method.
    // Three-way, not two: a subscribe channel that a remote client can actually
    // receive is "live", one that could only ever carry replies to a call the
    // browser is forbidden from making is "inert". Collapsing them would hide
    // the difference between "not built yet" and "nothing to build".
    const kind: ShimMemberKind = bridgeMemberIsHttpReadable(member)
      ? "read"
      : bridgeMemberIsHttpReducible(member)
        ? "reduce"
        : entry.kind === "subscribe"
        ? entry.noStream
          ? "inert"
          : `live:${entry.namespace}.list`
        : "no";
    // The INVOKE half always wins for a member that owns both channels, and
    // runStream is the one that does. Let its subscribe half win and the shim
    // would define `runStream` as a no-op subscription returning an unsubscribe
    // — so a caller that thinks it started a run gets silence instead of the
    // rejection that tells it the browser client cannot start runs. A silent
    // no-op on the member that spends money is the worst of the options.
    const existing = members[entry.method];
    const incomingIsSubscribe = entry.kind === "subscribe";
    if (existing === undefined || !incomingIsSubscribe) members[entry.method] = kind;
    namespaces.set(entry.namespace, members);
  }
  const servable = [...namespaces.entries()].filter(([, members]) => Object.values(members).includes("read"));
  const table = Object.fromEntries(servable);
  return `
(function () {
  var NS = ${scriptSafeJson(table)};
  function token() { return window.__METIS_GATEWAY_TOKEN__ || ""; }
  function call(member, args) {
    return fetch("/v1/bridge", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + token() },
      body: JSON.stringify({ member: member, args: Array.prototype.slice.call(args) })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok || !body || body.ok !== true) {
          throw new Error((body && body.error && body.error.message) || ("Metis gateway returned " + res.status + " for " + member));
        }
        return body.value;
      });
    });
  }
  function unavailable(member) {
    return function () {
      return Promise.reject(new Error(member + " needs the desktop app. The browser client is read-only."));
    };
  }
  function inertSubscription() { return function () {}; }
  // A live subscription, done by polling its namespace's list read.
  //
  // Not SSE, and that is the repo's own precedent rather than a shortcut: the
  // loops page next door polls on purpose, and says why — a loop's heartbeat is
  // 60 seconds, so a 10-second poll is already six times finer than the thing it
  // watches, and polling survives a laptop sleeping and a network switch with no
  // reconnect protocol. Streaming is the right answer for a chat turn's tokens
  // and the wrong one for a status list. It also needs no new route, no new auth
  // surface, and no widening of the ?token= bootstrap that EventSource would
  // have forced.
  //
  // metis-loops:changed carries NO payload — it means "re-read" — so a poll that
  // fires the callback when the list actually changed satisfies the contract
  // exactly rather than approximating it.
  function livePoll(readMember) {
    return function (cb) {
      var stopped = false, timer = null, last = null;
      function tick() {
        call(readMember, []).then(function (value) {
          if (stopped) return;
          var signature = JSON.stringify(value);
          // The first pass only records: firing on it would report a change
          // that is really just the subscription starting.
          if (last !== null && signature !== last) { try { cb(); } catch (e) {} }
          last = signature;
        }).catch(function () {}).then(function () {
          if (!stopped) timer = setTimeout(tick, 10000);
        });
      }
      tick();
      return function () { stopped = true; if (timer) clearTimeout(timer); };
    };
  }
  Object.keys(NS).forEach(function (name) {
    var members = NS[name];
    var api = {};
    Object.keys(members).forEach(function (method) {
      var kind = members[method];
      var member = name + "." + method;
      if (kind === "read" || kind === "reduce") { api[method] = function () { return call(member, arguments); }; }
      else if (kind.indexOf("live:") === 0) { api[method] = livePoll(kind.slice(5)); }
      else if (kind === "inert") { api[method] = inertSubscription; }
      else { api[method] = unavailable(member); }
    });
    window[name] = api;
  });
  window.__METIS_BRIDGE_SHIM__ = NS;
})();
`.trim();
}
