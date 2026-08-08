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
 */

/** Keys the renderer must never read or write through `metis-store:*`. */
export const RENDERER_BLOCKED_STORE_KEYS: ReadonlySet<string> = new Set(["secrets"]);

/** True when the renderer is allowed to reach this key generically.
 *
 *  Deliberately an exact-match denylist rather than a pattern. A pattern like
 *  /secret/i would also block keys that merely mention the word, and a guard
 *  that blocks more than it explains is one somebody later deletes in
 *  frustration rather than narrows. Add keys here as they earn it. */
export function rendererMayReachStoreKey(key: string): boolean {
  return !RENDERER_BLOCKED_STORE_KEYS.has(key);
}
