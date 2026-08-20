/** The store and the audit log, lifted out of main.ts.
 *
 *  Fourth carve of docs/STRUCTURAL_DEBT.md item 1, and the only one so far that
 *  is a true LEAF: measured at **zero** dependencies on the rest of `main.ts`.
 *  Every other module in the app depends on this one and it depends on none of
 *  them, which is why it goes early — a leaf can be imported rather than
 *  injected, so it does not add a parameter to anybody's dependency interface.
 *
 *  **It takes the userData directory rather than importing `app` for it**, and
 *  that is the whole reason this file is worth anything. The rule found on
 *  2026-08-20: a NAMED import from `"electron"` throws `Named export not found`
 *  at LOAD time in plain node, so any module carrying one cannot be imported
 *  outside the app and therefore cannot be tested at all — silently, because an
 *  untestable module does not fail a suite, it simply never appears in one. If
 *  `store.ts` imported `app`, then every module that imports the store would
 *  inherit that, and the carve would have made things worse rather than better.
 *
 *  With the directory injected instead, `33-store-behaviour` can point this at a
 *  temp folder and finally exercise the failure modes that were never covered:
 *  a corrupt JSON file falling back to its default rather than throwing, a key
 *  with a path separator in it being refused, and the audit log surviving a
 *  malformed line.
 */

import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rendererMayReachStoreKey } from "../shared/store-keys.js";
import type { AuditEvent } from "../shared/runtime-contracts.js";

/** A store key is a FILENAME. The pattern is the containment: no separators, no
 *  dots, no traversal — so a key can never address a path outside the store
 *  directory, whatever the caller passes. */
const storeKeyPattern = /^[a-zA-Z0-9_-]+$/;

let userDataDir: string | null = null;

/** Point the store at a directory. Called once from `main.ts` with
 *  `app.getPath("userData")`, and by tests with a temp folder. */
export function configureStore(directory: string): void {
  userDataDir = directory;
}

/** The store root, or a loud failure.
 *
 *  Never falls back to a default path: a store that silently writes somewhere
 *  else is a user's conversations and keys landing in a directory nobody looks
 *  in, discovered whenever they next go looking for them. */
function root(): string {
  if (!userDataDir) throw new Error("The store was used before configureStore() ran.");
  return userDataDir;
}

/** Refuses a renderer request for a key the renderer has no business reading.
 *
 *  Main-process code is unaffected: `readSecrets` calls `readStoreValue`
 *  directly and never crosses this boundary. Only the IPC entry points check. */
export function assertRendererMayReachStoreKey(key: string): void {
  if (!rendererMayReachStoreKey(key)) {
    throw new Error(
      `The store key "${key}" is not reachable from the renderer. Use the dedicated secrets IPC, which returns status rather than values.`
    );
  }
}

export function storePath(key: string): string {
  if (!storeKeyPattern.test(key)) {
    throw new Error(`Invalid store key: ${key}`);
  }
  return join(root(), "metis-store", `${key}.json`);
}

/** Reads a key, or the fallback.
 *
 *  The catch covers a missing file AND unparseable contents, deliberately: a
 *  half-written JSON file after a crash should read as "not set yet" rather
 *  than take down whatever asked for it.
 *
 *  What it does NOT do is check the shape. `JSON.parse(raw) as T` is a cast, so
 *  a file that parses to valid-but-wrong JSON is returned as-is, and a caller
 *  that immediately does `.map` on it throws. That is a real gap rather than a
 *  hypothetical one and it is recorded in docs/LIMITATIONS.md. */
export async function readStoreValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(storePath(key), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeStoreValue<T>(key: string, value: T): Promise<void> {
  const target = storePath(key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), "utf8");
}

export function dataPath(...parts: string[]): string {
  return join(root(), "metis-store", ...parts);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function appendAudit(
  level: AuditEvent["level"],
  kind: string,
  summary: string,
  metadata?: Record<string, unknown>
): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    level,
    kind,
    summary,
    metadata
  };
  const target = dataPath("audit-log.jsonl");
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

/** The newest `limit` events, newest first.
 *
 *  One malformed line collapses the whole call to `[]` rather than returning a
 *  partial list, because the outer catch covers the `.map`. That is a
 *  deliberate-enough trade (a truncated audit log reads as empty rather than as
 *  a lie about what happened) but it is worth knowing when the log looks empty
 *  and should not be. */
export async function listAudit(limit = 40): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(dataPath("audit-log.jsonl"), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditEvent)
      .reverse();
  } catch {
    return [];
  }
}
