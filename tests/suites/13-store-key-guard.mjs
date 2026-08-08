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

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { rendererMayReachStoreKey, RENDERER_BLOCKED_STORE_KEYS } = await fromBuild("shared/store-keys.js");

section("The key holding provider API keys is not renderer-reachable");
ok('"secrets" is blocked', rendererMayReachStoreKey("secrets") === false);
ok("the denylist is not empty", RENDERER_BLOCKED_STORE_KEYS.size > 0);
ok('and it is "secrets" that is on it', RENDERER_BLOCKED_STORE_KEYS.has("secrets"));

section("Ordinary keys still work, or the app breaks");
// These are real keys the renderer reads through readAppStore. Blocking any of
// them would be a functional regression, so they are asserted explicitly
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
