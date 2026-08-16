// The bridge manifest, checked against the real preload and the real handlers.
//
// Why this suite is the first thing built for browser parity, ahead of anything
// visible: the survey that motivated it found that `installIpcSenderGuard`
// authenticates frame TOPOLOGY, not identity — an HTTP caller has no
// `senderFrame`, so no handler inherits any protection once reached over HTTP.
// Parity is therefore re-exposing handlers as individually-authorized routes,
// not swapping a transport. That makes the exposed surface a 104-item decision,
// and a 104-item decision made from memory is one that goes wrong quietly.
//
// The precedent is one layer down and already bit: `shared/store-keys.ts`
// blocked the key `secrets` and missed the sibling `account-secrets` added
// later, because a denylist's failure mode is silence. This suite is the same
// lesson applied before the mistake instead of after — a channel added to the
// preload without a class fails the build.
//
// Offline: no provider is called, nothing is served, no API key is read.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { BRIDGE_CHANNELS, BRIDGE_MULTI_CHANNEL_MEMBERS, bridgeChannelsSafeToServe, bridgeChannelIsForbidden } =
  await fromBuild("shared/bridge-manifest.js");

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const preload = read("src", "electron", "preload.cts");
const main = read("src", "electron", "main.ts");

/** Every channel the preload actually reaches, extracted from source. */
const preloadChannels = new Map();
{
  let namespace = null;
  for (const line of preload.split(/\r?\n/)) {
    const exposed = /exposeInMainWorld\("(\w+)"/.exec(line);
    if (exposed) {
      namespace = exposed[1];
      continue;
    }
    const call = /ipcRenderer\.(invoke|send|on)\("([^"]+)"/.exec(line);
    if (call && namespace) preloadChannels.set(call[2], { namespace, kind: call[1] === "on" ? "subscribe" : call[1] });
  }
}

section("The manifest is the preload, not a story about it");
{
  const manifestChannels = new Set(BRIDGE_CHANNELS.map((entry) => entry.channel));
  const missing = [...preloadChannels.keys()].filter((channel) => !manifestChannels.has(channel)).sort();
  const phantom = [...manifestChannels].filter((channel) => !preloadChannels.has(channel)).sort();
  // A channel in the preload and not the table is an UNCLASSIFIED capability —
  // exactly the shape of the account-secrets miss. This assertion is the whole
  // point of the file.
  check("no preload channel is unclassified", missing, []);
  check("no manifest entry is imaginary", phantom, []);
  check("every channel is listed once", BRIDGE_CHANNELS.length, manifestChannels.size);
}

section("Kind and namespace match the source, per channel");
{
  const wrongKind = [];
  const wrongNamespace = [];
  for (const entry of BRIDGE_CHANNELS) {
    const actual = preloadChannels.get(entry.channel);
    if (!actual) continue;
    if (actual.kind !== entry.kind) wrongKind.push(`${entry.channel}: manifest ${entry.kind}, preload ${actual.kind}`);
    if (actual.namespace !== entry.namespace) wrongNamespace.push(`${entry.channel}: manifest ${entry.namespace}, preload ${actual.namespace}`);
  }
  check("kinds agree", wrongKind, []);
  // metisProject.setConversationProject owns a metis-conversations:* channel —
  // the one cross-namespace pair, which is why the channel can never be derived
  // from the namespace by convention.
  check("namespaces agree", wrongNamespace, []);
}

section("Every channel has a handler in main");
{
  // `\s*` across the paren, not `("` — prettier wraps a long registration so
  // the channel lands on the next line, and two real handlers
  // (metis-bus:post, metis-loops:create) are written that way. A single-line
  // regex reports them as orphaned, which is this check crying wolf about the
  // two channels it least should.
  const handled = new Set([
    ...[...main.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...main.matchAll(/ipcMain\.on\(\s*"([^"]+)"/g)].map((match) => match[1])
  ]);
  // A preload channel with no handler is a method that returns a rejected
  // promise forever, and nothing else in the repo would notice.
  const orphaned = BRIDGE_CHANNELS.filter((entry) => entry.kind !== "subscribe" && !handled.has(entry.channel))
    .map((entry) => entry.channel)
    .sort();
  check("no bridge method calls a channel nothing handles", orphaned, []);
}

section("The shape of the bridge, pinned so a change has to be noticed");
{
  // Hardcoded on purpose, this repo's idiom: a new member moves a number and
  // somebody has to look at it and classify it.
  check("channels", BRIDGE_CHANNELS.length, 104);
  check("namespaces", new Set(BRIDGE_CHANNELS.map((entry) => entry.namespace)).size, 31);
  check("invoke", BRIDGE_CHANNELS.filter((entry) => entry.kind === "invoke").length, 93);
  check("send", BRIDGE_CHANNELS.filter((entry) => entry.kind === "send").length, 6);
  check("subscribe", BRIDGE_CHANNELS.filter((entry) => entry.kind === "subscribe").length, 5);

  // 103 MEMBERS across 104 channels: runStream owns two. That gap is the least
  // mechanical thing in the bridge — it mints a correlation id in the preload,
  // subscribes with a closure filtering on it, invokes, then unsubscribes on
  // settle. No generated shim reproduces it; over HTTP the connection IS the
  // correlation and the id disappears.
  const members = new Set(BRIDGE_CHANNELS.map((entry) => `${entry.namespace}.${entry.method}`));
  check("members", members.size, 103);
  check("and exactly one member owns two channels", BRIDGE_CHANNELS.length - members.size, 1);
  for (const name of BRIDGE_MULTI_CHANNEL_MEMBERS) {
    const owned = BRIDGE_CHANNELS.filter((entry) => `${entry.namespace}.${entry.method}` === name);
    ok(`${name} owns ${owned.length} channels`, owned.length === 2);
  }
}

section("Every channel carries a class, and refusals carry a reason");
{
  const classes = new Set(["read", "write", "reduce", "decision", "host", "never"]);
  const unclassified = BRIDGE_CHANNELS.filter((entry) => !classes.has(entry.exposure)).map((entry) => entry.channel);
  check("no channel is unclassified", unclassified, []);
  // A refusal with no reason is one somebody relaxes later without knowing what
  // they are relaxing.
  const unexplained = BRIDGE_CHANNELS.filter(
    (entry) => (entry.exposure === "never" || entry.exposure === "decision") && !entry.why
  )
    .map((entry) => entry.channel)
    .sort();
  check("every never and decision says why", unexplained, []);
}

section("The channels that must never cross a network are named, not inferred");
{
  // Asserted BY NAME, the same way 13-store-key-guard names "secrets", so that
  // relaxing one is a red build rather than a quiet regression.
  for (const channel of [
    "metis-store:get",
    "metis-store:set",
    "metis-secrets:set",
    "metis-secrets:delete",
    "metis-permissions:request",
    "metis-registry:install",
    "metis-mcp:probe",
    "metis-gateway:get-status",
    "metis-gateway:set-enabled"
  ]) {
    ok(`"${channel}" is forbidden`, bridgeChannelIsForbidden(channel) === true);
  }
  // The near-miss that must stay readable: it returns which provider and which
  // storage tier, never a value.
  ok('"metis-secrets:list" is NOT forbidden', bridgeChannelIsForbidden("metis-secrets:list") === false);
  ok("an unknown channel is not forbidden by accident", bridgeChannelIsForbidden("metis-nonsense:nope") === false);
}

section("Nothing that spends money or writes your files is safe-to-serve");
{
  const safe = bridgeChannelsSafeToServe();
  ok(`${safe.length} channels are read-only`, safe.length > 20);
  ok("all of them are reads", safe.every((entry) => entry.exposure === "read"));
  // The assertion that matters: the safe list must never acquire a channel that
  // starts work, spends, grants, or touches the host.
  for (const channel of [
    "metis-session:run",
    "metis-loops:create",
    "metis-files:write",
    "metis-permissions:respond",
    "metis-project:select-folder",
    "metis-store:get"
  ]) {
    ok(`"${channel}" is not safe-to-serve`, !safe.some((entry) => entry.channel === channel));
  }
}

section("The values JSON cannot express are flagged");
{
  // IPC transports `undefined`; JSON over HTTP does not. An HTTP shim that does
  // not round-trip these through a null sentinel turns "not found" into a hang.
  const nullable = BRIDGE_CHANNELS.filter((entry) => entry.nullable).map((entry) => entry.channel).sort();
  check("the two channels that resolve undefined", nullable, ["metis-loops:stop", "metis-routines:run-now"]);
  for (const channel of nullable) {
    ok(`"${channel}" resolves T | undefined in the preload`, /Promise<[^>]*\|\s*undefined>/.test(preload) || preload.includes(channel));
  }
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
