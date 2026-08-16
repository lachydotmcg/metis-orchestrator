/** The phone page: watch your loops, stop one. Served BY the gateway so it is
 *  same-origin with /v1/loops, which is why it needs no CORS handling.
 *
 *  Deliberately one self-contained string with no build step, no framework and
 *  no network fetches of its own. The desktop renderer is 18k lines of React
 *  behind a Vite build; none of it is reusable here, because every component
 *  calls the Electron preload bridge directly and there is no abstraction
 *  layer to swap. Rather than pretend otherwise, this is a second, tiny client
 *  written against the same LoopRecord shape — the same call `cli.ts` made.
 *
 *  It POLLS rather than streams. A loop's own heartbeat is 60 seconds, so a
 *  10-second poll is already four times finer than the thing it watches, and
 *  polling survives the phone locking, the screen sleeping and a wifi-to-
 *  cellular switch without a reconnect protocol. Streaming is the right answer
 *  for a chat turn's tokens and the wrong one for a status list.
 *
 *  Reach is not this file's problem. The gateway stays bound to 127.0.0.1;
 *  putting it on a phone is `tailscale serve`'s job, which also supplies the
 *  real certificate that a secure context needs.
 */
/** JSON for embedding inside a <script> element.
 *
 *  JSON.stringify alone is NOT enough here, which the suite caught: it escapes
 *  quotes and backslashes but leaves `/` untouched, so a value containing
 *  `</script>` closes the script ELEMENT and escapes the string literal from
 *  the outside. The HTML parser gets there before the JS parser does. Escaping
 *  `<` to \\u003c is the standard fix and is invisible to JSON.parse.
 *
 *  The gateway token is 24 random bytes of hex today and could never contain
 *  a bracket. This is here because that is a property of one caller, not of
 *  this function, and per-device pairing tokens with user-chosen labels are
 *  already sketched in the roadmap. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function gatewayLoopsPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark light" />
<title>Metis loops</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --card:#171a21; --line:#252a34; --text:#e7e9ee; --muted:#8b91a0; --accent:#e8833a; --danger:#e5544b; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom)); }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:14px; }
  h1 { font-size:1.05rem; font-weight:600; margin:0; letter-spacing:-0.01em; }
  #tick { font-size:0.78rem; color:var(--muted); }
  .loop { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:13px 14px; margin-bottom:10px; }
  .goal { font-weight:500; margin-bottom:7px; overflow-wrap:anywhere; }
  .meta { font-size:0.8rem; color:var(--muted); display:flex; flex-wrap:wrap; gap:4px 12px; }
  .badge { display:inline-block; font-size:0.72rem; padding:2px 8px; border-radius:99px; border:1px solid var(--line); }
  .running .badge, .sleeping .badge { border-color:var(--accent); color:var(--accent); }
  .blocked { border-color:var(--danger); }
  .blocked .badge { border-color:var(--danger); color:var(--danger); }
  .summary { font-size:0.82rem; color:var(--muted); margin-top:8px; padding-top:8px; border-top:1px solid var(--line); overflow-wrap:anywhere; }
  /* 44px min target: this is the one destructive control on the page and it
     is being tapped with a thumb, often in a hurry. */
  button { margin-top:11px; min-height:44px; width:100%; background:transparent; color:var(--danger); border:1px solid var(--danger); border-radius:9px; font:inherit; font-weight:500; cursor:pointer; }
  button[disabled] { opacity:0.45; }
  #empty, #error { color:var(--muted); font-size:0.88rem; padding:22px 2px; }
  #error { color:var(--danger); }
</style>
</head>
<body>
<header><h1>Metis loops</h1><span id="tick">connecting…</span></header>
<div id="list"></div>
<div id="empty" hidden>No live loops. Anything you start on the desktop shows up here.</div>
<div id="error" hidden></div>
<script>
(function () {
  // Bootstrap: the token arrives in the URL because a scanned link cannot
  // carry a header. Move it out of the address bar immediately so it is not
  // sitting in browser history or over the user's shoulder.
  var injected = ${scriptSafeJson(token)};
  var url = new URL(window.location.href);
  if (url.searchParams.get("token")) {
    try { sessionStorage.setItem("metis-gateway-token", url.searchParams.get("token")); } catch (e) {}
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search);
  }
  var token = injected;
  try { token = sessionStorage.getItem("metis-gateway-token") || injected; } catch (e) {}

  var list = document.getElementById("list");
  var empty = document.getElementById("empty");
  var errorBox = document.getElementById("error");
  var tick = document.getElementById("tick");
  var busy = {};

  function api(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + token });
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function when(iso) {
    if (!iso) return "";
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "due now";
    var mins = Math.round(ms / 60000);
    return mins < 1 ? "wakes in under a minute" : mins < 60 ? "wakes in " + mins + "m" : "wakes in " + Math.round(mins / 60) + "h";
  }

  function render(loops) {
    // Loops that can still do something, PLUS blocked ones. A finished loop on
    // a phone is noise and the desktop panel is where history belongs — but a
    // blocked loop is the single most important thing this page can show you,
    // because it is a run that stopped without finishing and is waiting on a
    // decision only you can make. Filtering to live-only would have hidden
    // exactly the case worth carrying in your pocket.
    var live = loops.filter(function (l) { return l.status === "running" || l.status === "sleeping" || l.status === "blocked"; });
    empty.hidden = live.length > 0;
    list.textContent = "";
    live.forEach(function (loop) {
      var card = document.createElement("div");
      card.className = "loop " + loop.status;

      var goal = document.createElement("div");
      goal.className = "goal";
      // textContent throughout: a goal is user text and this page must never
      // become a place where a crafted goal string becomes markup.
      goal.textContent = loop.goal || "(no goal recorded)";
      card.appendChild(goal);

      var meta = document.createElement("div");
      meta.className = "meta";
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = loop.status;
      meta.appendChild(badge);
      [ "turn " + (loop.iterations || 0) + " of " + (loop.maxIterations || "?"),
        when(loop.nextWakeAt) ].forEach(function (text) {
        if (!text) return;
        var span = document.createElement("span");
        span.textContent = text;
        meta.appendChild(span);
      });
      card.appendChild(meta);

      var history = loop.history || [];
      var last = history.length ? history[history.length - 1] : null;
      if (last && (last.summary || last.error)) {
        var summary = document.createElement("div");
        summary.className = "summary";
        summary.textContent = last.error ? "failed: " + last.error : last.summary;
        card.appendChild(summary);
      }

      if (loop.status === 'blocked' && loop.stoppedReason) {
        var why = document.createElement('div');
        why.className = 'summary';
        why.textContent = loop.stoppedReason;
        card.appendChild(why);
      }

      // A blocked loop is already settled, so Stop would be a button that does
      // nothing. It is the one card here with no action, which is honest: the
      // action it needs is on the desktop.
      if (loop.status === 'blocked') { list.appendChild(card); return; }

      var stop = document.createElement("button");
      stop.textContent = busy[loop.id] ? "stopping…" : "Stop";
      stop.disabled = !!busy[loop.id];
      stop.addEventListener("click", function () {
        if (!window.confirm("Stop this loop?")) return;
        busy[loop.id] = true;
        stop.disabled = true;
        stop.textContent = "stopping…";
        api("/v1/loops/" + encodeURIComponent(loop.id) + "/stop", { method: "POST" })
          .then(refresh)
          .catch(function (err) { fail(err); })
          .then(function () { delete busy[loop.id]; });
      });
      card.appendChild(stop);
      list.appendChild(card);
    });
  }

  function fail(err) {
    errorBox.hidden = false;
    errorBox.textContent = String(err && err.message ? err.message : err) + " — is the desktop app still running?";
  }

  function refresh() {
    return api("/v1/loops")
      .then(function (payload) {
        errorBox.hidden = true;
        tick.textContent = "updated " + new Date().toLocaleTimeString();
        render(payload.data || []);
      })
      .catch(fail);
  }

  refresh();
  // Poll only while visible. A backgrounded phone tab gets throttled anyway,
  // and burning the battery to refresh a screen nobody is looking at is the
  // easiest thing here to get wrong.
  var timer = setInterval(function () { if (!document.hidden) refresh(); }, 10000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  window.addEventListener("pagehide", function () { clearInterval(timer); });
})();
</script>
</body>
</html>`;
}
