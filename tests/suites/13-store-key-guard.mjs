// The renderer's reach into the store. Imports the REAL predicate from the
// build rather than a copy, because a guard verified against a snapshot of
// itself is not verified.
//
// What it exists to prevent: `metis-store:get` forwards any key straight to
// readStoreValue, and provider API keys live at the store key "secrets". So
// the generic store channel was a second, unguarded way to read the key file,
// sitting right beside the deliberately narrow one — metis-secrets:list
// returns SecretStatus[] (which provider, which storage tier) and never a
// value. Nothing in the renderer ever asked for "secrets" generically, which
// is why closing it cost nothing.
//
// It was not reachable when this was written: the chat renders through
// react-markdown with no rehype-raw, so model-authored HTML is stripped rather
// than executed, and nothing untrusted runs in the renderer's origin. The
// point is the artifacts work. Rendering model-authored markup is exactly the
// change that would turn "unreachable" into "reachable", and this suite is
// what makes removing the guard a red build rather than a quiet regression.
//
// Offline: no provider is called and no API key is read.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { rendererMayReachStoreKey, RENDERER_BLOCKED_STORE_KEYS, STORE_KEY_OWNERS } = await fromBuild("shared/store-keys.js");

section("The key holding provider API keys is not renderer-reachable");
ok('"secrets" is blocked', rendererMayReachStoreKey("secrets") === false);
ok("the denylist is not empty", RENDERER_BLOCKED_STORE_KEYS.size > 0);
ok('and it is "secrets" that is on it', RENDERER_BLOCKED_STORE_KEYS.has("secrets"));

section("Credentials and authority live at more than one key");
{
  // Found 2026-08-16. The denylist blocked exactly "secrets" while POOLED
  // per-account credentials are written to "account-secrets" (readAccountSecrets
  // in main.ts) — a different key, and storeKeyPattern accepts a hyphen, so
  // metis-store:get("account-secrets") sailed through and returned StoredSecret
  // blobs. Their "plain-local" tier is base64 on disk wherever the platform has
  // no safeStorage. The exact second unguarded path this guard exists to close,
  // reopened by a sibling key added later.
  ok('"account-secrets" is blocked', rendererMayReachStoreKey("account-secrets") === false);
  // Authority, not secrets, and the reason a /secret/i pattern would not have
  // saved us either: this one has no such word in it.
  ok('"gatewayToken" is blocked', rendererMayReachStoreKey("gatewayToken") === false);
  // Reading it inventories what the agent may already do; WRITING it generically
  // would grant filesystem access with no audit line.
  ok('"permissions" is blocked', rendererMayReachStoreKey("permissions") === false);
  // The near-miss that must stay open: providerAccounts holds a keyRef and never
  // a key, and the renderer reads it to render the account pool.
  ok('"providerAccounts" stays reachable', rendererMayReachStoreKey("providerAccounts") === true);
}

section("Every key main writes is classified, so the next one cannot be invisible");
{
  // The structural half of the fix. A denylist cannot fail safe: a key added to
  // main.ts with a credential in it is invisible until somebody remembers. This
  // makes it a red build until somebody DECIDES.
  // Every main-process source, not just main.ts. The gateway was carved out to
  // ./gateway.ts on 2026-08-20 and took gatewayEnabled/gatewayToken with it,
  // which this assertion caught immediately — correctly, because the question is
  // "what does the main process write", and that stopped being one file. Reading
  // the directory means the next carve does not break it again.
  const main = readdirSync(join(process.cwd(), "src", "electron"))
    .filter((f) => f.endsWith(".ts") || f.endsWith(".cts"))
    .map((f) => readFileSync(join(process.cwd(), "src", "electron", f), "utf8"))
    .join("\n");
  const written = new Set([...main.matchAll(/writeStoreValue\("([a-zA-Z0-9_-]+)"/g)].map((match) => match[1]));
  ok(`${written.size} keys are written by main`, written.size > 10);

  const unclassified = [...written].filter((key) => !(key in STORE_KEY_OWNERS)).sort();
  check("every one of them is classified", unclassified, []);

  // And nothing classified has quietly stopped existing — a stale entry is a
  // smaller problem than a missing one, but it still means the table is being
  // maintained by nobody.
  const phantom = Object.keys(STORE_KEY_OWNERS).filter((key) => !written.has(key)).sort();
  check("and nothing classified has disappeared", phantom, []);

  // The classification is not itself the enforcement — the denylist is — so the
  // two must agree about the keys that matter. Every blocked key must be
  // main-owned; a blocked key the renderer needs is a broken app.
  for (const key of RENDERER_BLOCKED_STORE_KEYS) {
    check(`"${key}" is classified main`, STORE_KEY_OWNERS[key], "main");
  }
  // Renderer-owned keys must be reachable, or blocking one breaks a surface.
  for (const [key, owner] of Object.entries(STORE_KEY_OWNERS)) {
    if (owner === "renderer") ok(`"${key}" is reachable`, rendererMayReachStoreKey(key) === true);
  }
}

section("Ordinary keys still work, or the app breaks");
// Real keys that must stay open. Most are renderer-owned settings; a couple
// (conversations, usageLedger) are main-written and reached through their own
// narrow channels rather than generically — they are here because the guard
// must stay NARROW, not because the renderer reads them this way. Blocking any
// of them would be a functional regression, so they are asserted explicitly
// rather than assumed.
for (const key of [
  "conversations",
  "settings",
  "projects",
  "agentToolsEnabled",
  "knowledgeBankEnabled",
  "depthRoutingEnabled",
  "oracleCloudEnabled",
  "graphPresets",
  "usageLedger"
]) {
  ok(`"${key}" is reachable`, rendererMayReachStoreKey(key) === true);
}

section("The guard is an exact match, not a pattern");
// Deliberate: /secret/i would also block keys that merely mention the word,
// and a guard that blocks more than it explains gets deleted in frustration
// rather than narrowed. If these ever need blocking they go on the list by
// name, and this section changes with them.
check("a key merely containing the word is not blocked", rendererMayReachStoreKey("secretsPanelCollapsed"), true);
check("a differently-cased key is not silently blocked", rendererMayReachStoreKey("Secrets"), true);
check("a near-miss is not blocked", rendererMayReachStoreKey("secret"), true);

section("Edge shapes cannot slip past");
check("empty string", rendererMayReachStoreKey(""), true);
check("a key with the blocked name as a prefix", rendererMayReachStoreKey("secrets-backup"), true);
check("a key with the blocked name as a suffix", rendererMayReachStoreKey("old-secrets"), true);

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
