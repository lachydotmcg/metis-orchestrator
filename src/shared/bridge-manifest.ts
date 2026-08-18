/** Every channel the renderer can reach, and what it would mean to expose it.
 *
 *  This exists because of a question with a surprising answer: could the same
 *  renderer run in a browser, served over the Metis Gateway, by swapping the
 *  preload's `ipcRenderer.invoke` for HTTP? The transport is nearly uniform —
 *  93 of 104 channels are thin invoke wrappers — so mechanically, yes.
 *
 *  And it does not help, for a reason worth writing down before anyone tries:
 *
 *  **`installIpcSenderGuard` cannot be proxied.** It authenticates frame
 *  TOPOLOGY (`senderFrame.parent !== null`), not identity. An HTTP caller has
 *  no `senderFrame` at all, so a route either calls the underlying function
 *  directly or synthesises an event that trivially satisfies the check. Either
 *  way no handler inherits any protection once reached over HTTP. Parity means
 *  re-exposing handlers as routes that each carry their own authorization — it
 *  is not a transport swap, and this table is what makes that surface countable
 *  instead of a 104-item guess.
 *
 *  The failure this prevents is specific and has already happened once, one
 *  layer down: `shared/store-keys.ts` blocked the key `secrets` and missed the
 *  sibling key `account-secrets` added later, because a denylist's failure mode
 *  is silence. So every channel here carries an `exposure`, and the suite fails
 *  the build on a channel that has none. The decision becomes mandatory rather
 *  than remembered.
 *
 *  Nothing reads this at runtime yet. It is a classification with a test, and
 *  that is deliberate: the classification has to be right before anything is
 *  built on top of it.
 */

/** How a bridge member talks to main. */
export type BridgeKind = "invoke" | "send" | "subscribe";

/** What it would mean to reach this channel from something that is not the
 *  desktop renderer sitting in front of the person who owns the machine.
 *
 *  - `read`     Returns data and changes nothing. Safe behind auth.
 *  - `write`    Mutates app-owned state. No money, no permission grants, no
 *               reads or writes outside app data.
 *  - `reduce`   Can only ever DECREASE what the machine is doing. Safe by the
 *               same argument the existing `POST /v1/loops/:id/stop` route uses.
 *  - `decision` Starts work, spends money, or touches the user's own files.
 *               Exposing any of these is a product judgement, never a refactor.
 *  - `host`     Only meaningful on the machine running the app — a native
 *               dialog, a window control, opening a path in the OS shell. There
 *               is no remote equivalent; a browser version is a new feature.
 *  - `never`    Must not cross a network boundary at any point. Credentials,
 *               the gateway's own auth, arbitrary store access, process spawn.
 */
export type BridgeExposure = "read" | "write" | "reduce" | "decision" | "host" | "never";

export interface BridgeChannel {
  namespace: string;
  /** The method on `window[namespace]` that owns this channel. Not unique:
   *  `metisSession.runStream` owns two (see BRIDGE_MULTI_CHANNEL_MEMBERS). */
  method: string;
  channel: string;
  kind: BridgeKind;
  exposure: BridgeExposure;
  /** Resolves to `T | undefined` on the IPC path. IPC transports `undefined`;
   *  JSON over HTTP does not, so any HTTP shim must round-trip these through a
   *  null sentinel or silently turn "not found" into a hang. */
  nullable?: true;
  /** Why this channel is `never` or `decision`, in one line. Required for
   *  those two classes by the suite: a refusal without a reason is one somebody
   *  relaxes later without knowing what they are relaxing. */
  why?: string;
  /** Set on a channel classified `read` that must still NOT get an HTTP route,
   *  with the reason. `read` was assigned against the DESKTOP threat model —
   *  "this only reads, so the renderer may have it" — and four channels that
   *  pass that test fail a different one once the caller is remote. Reading the
   *  list back before serving it is what caught them; serving
   *  `bridgeChannelsSafeToServe()` mechanically would have shipped an SSRF
   *  primitive. Required by the suite wherever it is set. */
  noHttp?: string;
}

/** The one member that owns more than one channel, called out by name because
 *  it is the reason "member count" and "channel count" differ (103 vs 104) and
 *  because it is the least mechanical thing in the whole bridge:
 *  `runStream` mints a correlation id IN THE PRELOAD, subscribes with a closure
 *  that filters on it, invokes, and removes the listener on settle. No
 *  generated shim reproduces that — over HTTP the connection itself is the
 *  correlation, and the id disappears. */
export const BRIDGE_MULTI_CHANNEL_MEMBERS: ReadonlyArray<string> = ["metisSession.runStream"];

export const BRIDGE_CHANNELS: ReadonlyArray<BridgeChannel> = [
  { namespace: "metisPolicy", method: "getSampleDecision", channel: "metis-policy:get-sample-decision", kind: "invoke", exposure: "read" },
  { namespace: "metisPolicy", method: "getStatus", channel: "metis-policy:get-status", kind: "invoke", exposure: "read" },
  { namespace: "metisPolicy", method: "decide", channel: "metis-policy:decide", kind: "invoke", exposure: "read", noHttp: "Runs the router on caller-supplied text, and reaches a model when model-driven routing is on. A decision, not a panel read." },

  { namespace: "metisStore", method: "get", channel: "metis-store:get", kind: "invoke", exposure: "never", why: "Generic key access; the key-level guard is a denylist and has already been outrun once by a sibling key." },
  { namespace: "metisStore", method: "set", channel: "metis-store:set", kind: "invoke", exposure: "never", why: "Same, and a write here can grant permissions or clear every provider key with no audit line." },

  { namespace: "metisWindow", method: "minimize", channel: "metis-window:minimize", kind: "send", exposure: "host" },
  { namespace: "metisWindow", method: "toggleMaximize", channel: "metis-window:toggle-maximize", kind: "send", exposure: "host" },
  { namespace: "metisWindow", method: "close", channel: "metis-window:close", kind: "send", exposure: "host" },

  { namespace: "metisShell", method: "openExternal", channel: "metis-shell:open-external", kind: "invoke", exposure: "host" },
  { namespace: "metisShell", method: "openPath", channel: "metis-shell:open-path", kind: "invoke", exposure: "host" },

  { namespace: "metisSession", method: "run", channel: "metis-session:run", kind: "invoke", exposure: "decision", why: "Starts a run: spends money and carries a permission mode." },
  { namespace: "metisSession", method: "runStream", channel: "metis-session:run-stream", kind: "invoke", exposure: "decision", why: "Starts a run, streamed." },
  { namespace: "metisSession", method: "runStream", channel: "metis-session:stream-event", kind: "subscribe", exposure: "read", why: "Watching is a read, but it is sender-addressed today so a second client sees nothing." },
  { namespace: "metisSession", method: "list", channel: "metis-session:list", kind: "invoke", exposure: "read" },
  { namespace: "metisSession", method: "cancel", channel: "metis-session:cancel", kind: "send", exposure: "reduce" },
  { namespace: "metisSession", method: "answerQuestion", channel: "metis-session:answer-question", kind: "send", exposure: "decision", why: "Answering for the owner from a device that cannot see what is being asked." },

  { namespace: "metisBus", method: "post", channel: "metis-bus:post", kind: "invoke", exposure: "decision", why: "Steers a run already in flight." },
  { namespace: "metisBus", method: "list", channel: "metis-bus:list", kind: "invoke", exposure: "read" },

  { namespace: "metisConversations", method: "list", channel: "metis-conversations:list", kind: "invoke", exposure: "read" },
  { namespace: "metisConversations", method: "create", channel: "metis-conversations:create", kind: "invoke", exposure: "write" },
  { namespace: "metisConversations", method: "delete", channel: "metis-conversations:delete", kind: "invoke", exposure: "write" },
  { namespace: "metisConversations", method: "deleteProject", channel: "metis-conversations:delete-project", kind: "invoke", exposure: "write" },
  { namespace: "metisConversations", method: "rename", channel: "metis-conversations:rename", kind: "invoke", exposure: "write" },
  { namespace: "metisConversations", method: "fork", channel: "metis-conversations:fork", kind: "invoke", exposure: "write" },
  { namespace: "metisConversations", method: "archive", channel: "metis-conversations:archive", kind: "invoke", exposure: "write" },
  { namespace: "metisConversations", method: "exportMarkdown", channel: "metis-conversations:export", kind: "invoke", exposure: "host", why: "Opens a save dialog on the machine's own screen." },

  { namespace: "metisKnowledge", method: "searchConversations", channel: "metis-knowledge:searchConversations", kind: "invoke", exposure: "read" },

  { namespace: "metisLab", method: "runExperiment", channel: "metis-lab:run-experiment", kind: "invoke", exposure: "decision", why: "Runs models." },

  { namespace: "metisProfile", method: "get", channel: "metis-profile:get", kind: "invoke", exposure: "read" },
  { namespace: "metisProfile", method: "set", channel: "metis-profile:set", kind: "invoke", exposure: "write" },

  { namespace: "metisProject", method: "getWorkspace", channel: "metis-project:get-workspace", kind: "invoke", exposure: "read" },
  { namespace: "metisProject", method: "snapshot", channel: "metis-project:snapshot", kind: "invoke", exposure: "decision", why: "Reads the user's project files." },
  { namespace: "metisProject", method: "selectFolder", channel: "metis-project:select-folder", kind: "invoke", exposure: "host", why: "Native dialog: the desktop user's click would become the remote caller's write grant." },
  { namespace: "metisProject", method: "clearWorkspace", channel: "metis-project:clear-workspace", kind: "invoke", exposure: "write" },
  { namespace: "metisProject", method: "listResources", channel: "metis-project:list-resources", kind: "invoke", exposure: "read" },
  { namespace: "metisProject", method: "addFiles", channel: "metis-project:add-files", kind: "invoke", exposure: "host", why: "Native dialog, same reason as selectFolder." },
  { namespace: "metisProject", method: "addFolder", channel: "metis-project:add-folder", kind: "invoke", exposure: "host", why: "Native dialog, same reason as selectFolder." },
  { namespace: "metisProject", method: "removeResource", channel: "metis-project:remove-resource", kind: "invoke", exposure: "write" },
  { namespace: "metisProject", method: "claimPendingResources", channel: "metis-project:claim-pending", kind: "invoke", exposure: "write" },
  { namespace: "metisProject", method: "lastSnapshot", channel: "metis-project:last-snapshot", kind: "invoke", exposure: "read" },
  { namespace: "metisProject", method: "revertSnapshot", channel: "metis-project:revert-snapshot", kind: "invoke", exposure: "decision", why: "Overwrites the user's files from a backup." },
  { namespace: "metisProject", method: "bindConversation", channel: "metis-project:bind-conversation", kind: "invoke", exposure: "write" },
  // The one cross-namespace channel: metisProject owns a metis-conversations:* channel.
  { namespace: "metisProject", method: "setConversationProject", channel: "metis-conversations:set-project", kind: "invoke", exposure: "write" },

  { namespace: "metisFiles", method: "read", channel: "metis-files:read", kind: "invoke", exposure: "decision", why: "Reads the user's files; the path guard is only as tight as a grant list the caller can extend." },
  { namespace: "metisFiles", method: "write", channel: "metis-files:write", kind: "invoke", exposure: "decision", why: "Writes the user's files." },

  { namespace: "metisArtifacts", method: "readImage", channel: "metis-artifacts:read-image", kind: "invoke", exposure: "read" },

  { namespace: "metisSecrets", method: "list", channel: "metis-secrets:list", kind: "invoke", exposure: "read", why: "Returns SecretStatus — which provider, which storage tier — and never a value." },
  { namespace: "metisSecrets", method: "set", channel: "metis-secrets:set", kind: "invoke", exposure: "never", why: "Writes a provider API key." },
  { namespace: "metisSecrets", method: "delete", channel: "metis-secrets:delete", kind: "invoke", exposure: "never", why: "Deletes a provider API key." },

  { namespace: "metisPermissions", method: "list", channel: "metis-permissions:list", kind: "invoke", exposure: "read" },
  { namespace: "metisPermissions", method: "request", channel: "metis-permissions:request", kind: "invoke", exposure: "never", why: "Writes a grant from caller-supplied scope/target with no prompt, so it can widen the filesystem guard it is checked against." },
  { namespace: "metisPermissions", method: "revoke", channel: "metis-permissions:revoke", kind: "invoke", exposure: "reduce" },
  { namespace: "metisPermissions", method: "respond", channel: "metis-permissions:respond", kind: "send", exposure: "decision", why: "A remote token becomes the agent's consent to write files." },

  { namespace: "metisAudit", method: "list", channel: "metis-audit:list", kind: "invoke", exposure: "read" },

  { namespace: "metisProviders", method: "list", channel: "metis-providers:list", kind: "invoke", exposure: "read" },
  { namespace: "metisProviders", method: "healthCheck", channel: "metis-providers:health-check", kind: "invoke", exposure: "decision", why: "Calls every configured provider." },
  { namespace: "metisProviders", method: "invoke", channel: "metis-providers:invoke", kind: "invoke", exposure: "decision", why: "Direct provider call: spends money with no routing and no ledger attribution." },

  { namespace: "metisRegistry", method: "fetchUrl", channel: "metis-registry:fetch", kind: "invoke", exposure: "decision", why: "Outbound network fetch on the machine's behalf." },
  { namespace: "metisRegistry", method: "list", channel: "metis-registry:list", kind: "invoke", exposure: "read" },
  // Sits one line under `fetchUrl`, which is `decision` for "Outbound network
  // fetch on the machine's behalf" — and takes a `sourceUrl` it then fetches,
  // which is the same capability wearing a read's name. Over HTTP that is an
  // SSRF primitive: a caller names a URL and the MAIN PROCESS requests it.
  { namespace: "metisRegistry", method: "refresh", channel: "metis-registry:refresh", kind: "invoke", exposure: "read", noHttp: "Takes a sourceUrl the main process then fetches — an SSRF primitive once the caller is remote." },
  { namespace: "metisRegistry", method: "listInstalled", channel: "metis-registry:list-installed", kind: "invoke", exposure: "read" },
  { namespace: "metisRegistry", method: "install", channel: "metis-registry:install", kind: "invoke", exposure: "never", why: "Installs a package onto the machine." },
  { namespace: "metisRegistry", method: "uninstall", channel: "metis-registry:uninstall", kind: "invoke", exposure: "decision", why: "Removes an installed package." },

  { namespace: "metisMcp", method: "probe", channel: "metis-mcp:probe", kind: "invoke", exposure: "never", why: "Spawns a local stdio process." },

  { namespace: "metisCatalog", method: "models", channel: "metis-catalog:models", kind: "invoke", exposure: "read" },
  { namespace: "metisPulse", method: "feed", channel: "metis-pulse:feed", kind: "invoke", exposure: "read" },

  { namespace: "metisUsage", method: "summary", channel: "metis-usage:summary", kind: "invoke", exposure: "read" },
  { namespace: "metisUsage", method: "setLimits", channel: "metis-usage:set-limits", kind: "invoke", exposure: "write" },

  { namespace: "metisPreference", method: "signal", channel: "metis-preference:signal", kind: "invoke", exposure: "write" },
  { namespace: "metisPreference", method: "summary", channel: "metis-preference:summary", kind: "invoke", exposure: "read" },

  { namespace: "metisRoutines", method: "list", channel: "metis-routines:list", kind: "invoke", exposure: "read" },
  { namespace: "metisRoutines", method: "save", channel: "metis-routines:save", kind: "invoke", exposure: "write" },
  { namespace: "metisRoutines", method: "delete", channel: "metis-routines:delete", kind: "invoke", exposure: "write" },
  { namespace: "metisRoutines", method: "runNow", channel: "metis-routines:run-now", kind: "invoke", exposure: "decision", nullable: true, why: "Starts a run." },
  { namespace: "metisRoutines", method: "dryRun", channel: "metis-routines:dry-run", kind: "invoke", exposure: "decision", why: "Calls a model to preview the routine." },

  { namespace: "metisLoops", method: "list", channel: "metis-loops:list", kind: "invoke", exposure: "read" },
  { namespace: "metisLoops", method: "create", channel: "metis-loops:create", kind: "invoke", exposure: "decision", why: "Starts an autonomous run that keeps spending after the caller disconnects." },
  { namespace: "metisLoops", method: "usage", channel: "metis-loops:usage", kind: "invoke", exposure: "read" },
  { namespace: "metisLoops", method: "draftChain", channel: "metis-loops:draft-chain", kind: "invoke", exposure: "decision", why: "Calls a model." },
  { namespace: "metisLoops", method: "stop", channel: "metis-loops:stop", kind: "invoke", exposure: "reduce", nullable: true },
  { namespace: "metisLoops", method: "delete", channel: "metis-loops:delete", kind: "invoke", exposure: "write" },
  { namespace: "metisLoops", method: "onChanged", channel: "metis-loops:changed", kind: "subscribe", exposure: "read" },

  { namespace: "metisOllama", method: "list", channel: "metis-ollama:list", kind: "invoke", exposure: "read" },
  { namespace: "metisOllama", method: "pull", channel: "metis-ollama:pull", kind: "invoke", exposure: "decision", why: "Downloads gigabytes onto the machine." },
  { namespace: "metisOllama", method: "onPullProgress", channel: "metis-ollama:pull-progress", kind: "subscribe", exposure: "read" },

  { namespace: "metisPrewarm", method: "warm", channel: "metis-prewarm:warm", kind: "invoke", exposure: "decision", why: "Runs a local model speculatively." },
  { namespace: "metisPrewarm", method: "draft", channel: "metis-prewarm:draft", kind: "invoke", exposure: "decision", why: "Runs a local model speculatively." },
  { namespace: "metisPrewarm", method: "draftCloud", channel: "metis-prewarm:draft-cloud", kind: "invoke", exposure: "decision", why: "Spends real money on every keystroke pause." },
  { namespace: "metisPrewarm", method: "onDraftDelta", channel: "metis-prewarm:draft-delta", kind: "subscribe", exposure: "read" },
  { namespace: "metisPrewarm", method: "route", channel: "metis-prewarm:route", kind: "invoke", exposure: "read", noHttp: "Returns void and warms a route cache — it causes background work rather than reporting state, so nothing in a panel needs it." },

  { namespace: "metisManager", method: "chat", channel: "metis-manager:chat", kind: "invoke", exposure: "decision", why: "Calls a model." },
  { namespace: "metisManager", method: "chatStream", channel: "metis-manager:chat-stream", kind: "invoke", exposure: "decision", why: "Calls a model." },
  { namespace: "metisManager", method: "onChatStreamEvent", channel: "metis-manager:chat-stream-event", kind: "subscribe", exposure: "read" },
  { namespace: "metisManager", method: "runAction", channel: "metis-manager:action", kind: "invoke", exposure: "decision", why: "Executes a model-proposed action." },

  { namespace: "metisUpdates", method: "check", channel: "metis-updates:check", kind: "invoke", exposure: "read", noHttp: "Outbound egress to the releases API on request. Harmless, but nothing in a browser panel needs it, and a read route that reaches the internet is not a read." },

  { namespace: "metisGateway", method: "getStatus", channel: "metis-gateway:get-status", kind: "invoke", exposure: "never", why: "Returns the gateway's raw bearer token — the auth for every route the browser client would use." },
  { namespace: "metisGateway", method: "setEnabled", channel: "metis-gateway:set-enabled", kind: "invoke", exposure: "never", why: "A remote client must not be able to turn its own front door on, or off for everyone else." },

  { namespace: "metisGallery", method: "analyzeBoard", channel: "metis-gallery:analyze-board", kind: "invoke", exposure: "decision", why: "Calls a vision model." },
  { namespace: "metisGallery", method: "analyzeImage", channel: "metis-gallery:analyze-image", kind: "invoke", exposure: "decision", why: "Calls a vision model." },
  { namespace: "metisGallery", method: "cards", channel: "metis-gallery:cards", kind: "invoke", exposure: "read" },
  { namespace: "metisGallery", method: "updateCard", channel: "metis-gallery:update-card", kind: "invoke", exposure: "write" },
  { namespace: "metisGallery", method: "deleteCard", channel: "metis-gallery:delete-card", kind: "invoke", exposure: "write" },
  { namespace: "metisGallery", method: "importUrls", channel: "metis-gallery:import-urls", kind: "invoke", exposure: "decision", why: "Outbound fetch of caller-supplied URLs." },
  { namespace: "metisGallery", method: "importPinterest", channel: "metis-gallery:import-pinterest", kind: "invoke", exposure: "decision", why: "Outbound fetch." }
];

/** Channels that may be served over HTTP without a further product decision.
 *  `read` only — `write` is deliberately excluded even though it spends nothing,
 *  because "a browser can silently rename your conversations" is still a choice
 *  somebody should make on purpose. */
export function bridgeChannelsSafeToServe(): BridgeChannel[] {
  return BRIDGE_CHANNELS.filter((entry) => entry.exposure === "read");
}

/** The channels that actually get an HTTP route: `read`, request/response, and
 *  not carrying a `noHttp` reason.
 *
 *  Three filters, and the second is the one that is easy to miss. `read` alone
 *  returns 35 channels, five of which are SUBSCRIBE channels — push, not
 *  request/response. A shim that treats `metisLoops.onChanged` as a callable
 *  read gets a promise that never settles and a panel that never populates.
 *  Those five need an event stream, which is its own slice.
 *
 *  The third filter is the one that matters most: see `noHttp`. */
export function bridgeChannelsHttpReadable(): BridgeChannel[] {
  return BRIDGE_CHANNELS.filter((entry) => entry.exposure === "read" && entry.kind === "invoke" && !entry.noHttp);
}

/** True when the MEMBER (`namespace.method`) has an HTTP route. The gateway
 *  checks this per request and the shim generator uses it to decide which
 *  members fetch and which reject. Keyed on the member rather than the channel
 *  because a browser calls methods, and the two are not one-to-one. */
export function bridgeMemberIsHttpReadable(member: string): boolean {
  return bridgeChannelsHttpReadable().some((entry) => `${entry.namespace}.${entry.method}` === member);
}

/** True when this channel must not cross a network boundary at any point. */
export function bridgeChannelIsForbidden(channel: string): boolean {
  return BRIDGE_CHANNELS.some((entry) => entry.channel === channel && entry.exposure === "never");
}
