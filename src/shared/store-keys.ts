/** Which store keys the renderer may reach through the generic store channel.
 *
 *  `metis-store:get` forwards any key straight to readStoreValue, and provider
 *  API keys live at the store key "secrets". So the generic channel was a
 *  second, unguarded way to read the key file, sitting right next to the
 *  deliberately narrow one: `metis-secrets:list` returns `SecretStatus[]` —
 *  which provider, which storage tier — and never a value.
 *
 *  Lives in shared/ rather than main.ts so the offline suite can import the
 *  REAL predicate instead of a copy of its body, same reason as line-diff and
 *  depth-stack. A guard verified by a snapshot of itself is not verified.
 *
 *  ---
 *
 *  **2026-08-16: the denylist had a hole, and the hole was structural.**
 *
 *  It blocked exactly `"secrets"`. Pooled per-account credentials are written
 *  to a DIFFERENT key, `"account-secrets"` (readAccountSecrets in main.ts), and
 *  `storeKeyPattern` accepts a hyphen — so `metis-store:get("account-secrets")`
 *  passed the guard and returned `StoredSecret` blobs, whose `plain-local` tier
 *  is base64 on disk whenever the platform has no `safeStorage`. The exact
 *  second unguarded path this file was written to close, reopened by a sibling
 *  key added later.
 *
 *  A denylist cannot fail safe against that. Its failure mode is silent: nobody
 *  finds out a key was missed until it is read. So the fix is not another entry
 *  — it is CLASSIFY_EVERY_KEY below, which makes an unclassified key a red
 *  build. The denylist stays as the enforcement mechanism because it is the
 *  cheap check on the hot path; the classification is what stops the next
 *  sibling key from being invisible.
 */

/** Keys the renderer must never read or write through `metis-store:*`. */
export const RENDERER_BLOCKED_STORE_KEYS: ReadonlySet<string> = new Set([
  // Provider API keys, one entry per provider.
  "secrets",
  // Pooled per-account credentials (DRILL_PLAN Phase 6 §19). `providerAccounts`
  // is deliberately NOT here: it holds a `keyRef` and never a key, and the
  // renderer legitimately reads it to render the account pool.
  "account-secrets",
  // The gateway's bearer token. The renderer gets it through
  // `metis-gateway:get-status`, which is the narrow channel that exists for it;
  // the generic path would hand the whole HTTP surface's auth to anything that
  // can reach the store.
  "gatewayToken",
  // Filesystem/permission grants. Reading them is an inventory of what the
  // agent may already do; WRITING them generically would let the renderer grant
  // itself write access with no audit line — the same argument the `secrets`
  // write-block makes. `metis-permissions:list` is the narrow read.
  "permissions"
]);

/** Every store key the main process writes, and whether the renderer may reach
 *  it through the generic channel.
 *
 *  This exists because the denylist above cannot fail safe on its own. A key
 *  added to main.ts with a credential in it is invisible to a denylist until
 *  somebody remembers; here, it is a build failure until somebody DECIDES.
 *
 *  "renderer" means the renderer genuinely reads or writes it through
 *  `useAppStoreState` / `metisStore` and blocking it would break a real
 *  surface. "main" means main-process state the renderer has no business
 *  touching generically, whether or not it is secret — a narrow IPC channel
 *  exists wherever the renderer needs the data.
 *
 *  Adding a key to main.ts without adding it here fails `13-store-key-guard`.
 *  That is the whole point: the decision becomes mandatory rather than
 *  remembered. */
export const STORE_KEY_OWNERS: Readonly<Record<string, "renderer" | "main">> = {
  // --- credentials and authority: never generically reachable ---
  secrets: "main",
  "account-secrets": "main",
  gatewayToken: "main",
  permissions: "main",

  // --- main-process state with its own narrow channel ---
  conversations: "main",
  sessionRuns: "main",
  loops: "main",
  routines: "main",
  pulseFeed: "main",
  styleCards: "main",
  registryState: "main",
  installedPackages: "main",
  lastProjectSnapshot: "main",
  projectResourcesByKey: "main",
  projectWorkspace: "main",
  preferenceLog: "main",
  usageLedger: "main",
  usageLimits: "main",
  remoteModelCatalog: "main",
  profile: "main",
  // Written by main, toggled by the renderer through their own narrow channels
  // (`metis-gateway:set-enabled`, `metis-routines:set-paused`) rather than
  // generically — so neither needs the generic path open.
  gatewayEnabled: "main",
  routinesPaused: "main",

  // --- renderer-owned: read/written through useAppStoreState, and blocking
  // any of these would break a real surface ---
  providerAccounts: "renderer",
  todoBoard: "renderer",
  closeToTray: "renderer"
};

/** True when the renderer is allowed to reach this key generically.
 *
 *  Deliberately an exact-match denylist rather than a pattern. A pattern like
 *  /secret/i would also block keys that merely mention the word, and a guard
 *  that blocks more than it explains is one somebody later deletes in
 *  frustration rather than narrows — and it would have missed `gatewayToken`
 *  anyway, which is authority without the word "secret" in it. */
export function rendererMayReachStoreKey(key: string): boolean {
  return !RENDERER_BLOCKED_STORE_KEYS.has(key);
}
