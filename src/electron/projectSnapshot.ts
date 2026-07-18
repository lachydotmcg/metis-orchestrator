/** The safety net that runs before Metis writes into someone's project
 *  (docs/DRILL_PLAN.md CORE.5).
 *
 *  Lachy's completion bar for the core experience was "safe (permissions and
 *  version control?)". Permissions already gate WHETHER a write happens. This
 *  is the other half: making a write RECOVERABLE. An AI that edits your files
 *  is only trustworthy if undoing it is trivial, and "trust the model" is not
 *  a recovery strategy.
 *
 *  Two layers, because the folder may or may not be a git repo:
 *
 *  1. ALWAYS: copy the current contents of every file about to be written
 *     into an app-data snapshot folder, with a manifest. Bounded (only the
 *     files being touched), fast, and works in any folder including one with
 *     no version control at all. This is the layer that actually guarantees
 *     recovery.
 *
 *  2. WHEN THE FOLDER IS A GIT REPO: additionally record a `git stash create`
 *     commit under a Metis-owned ref. This captures the WHOLE working tree
 *     rather than just the touched files, and gives a git-native way back.
 *     Deliberately chosen because `stash create` writes a commit object
 *     WITHOUT touching the index, the working tree, or the stash list, so it
 *     cannot disturb work in progress. Metis never runs git init, never
 *     commits to a branch, and never modifies existing history.
 *
 *  Failure policy: layer 1 failing is reported to the caller so the pipeline
 *  can decide (fail closed for autonomous writes). Layer 2 failing is
 *  ignored, since layer 1 already covers recovery. */

import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, copyFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SnapshotEntry {
  /** Path relative to the project root, as the write set names it. */
  relativePath: string;
  /** True when the file did not exist before this run (so reverting means deleting it). */
  createdByRun: boolean;
}

export interface ProjectSnapshot {
  id: string;
  createdAt: string;
  projectRoot: string;
  /** Absolute path of the folder holding the copied originals. */
  snapshotDir: string;
  entries: SnapshotEntry[];
  /** Set only when the project is a git repo and the stash object was made. */
  gitRef?: string;
  gitCommit?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, windowsHide: true });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Records the whole working tree as a stash commit under a Metis-owned ref,
 *  WITHOUT touching the index, working tree, or the user's stash list.
 *  Returns null when the repo is clean (nothing to stash) or anything fails -
 *  the file-copy layer is the real guarantee, this is a bonus. */
async function createGitSnapshot(root: string, id: string): Promise<{ ref: string; commit: string } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["stash", "create", `metis snapshot ${id}`], { cwd: root, windowsHide: true });
    const commit = stdout.trim();
    if (!commit) return null; // Clean tree: HEAD is already the restore point.
    const ref = `refs/metis/snapshot-${id}`;
    await execFileAsync("git", ["update-ref", ref, commit], { cwd: root, windowsHide: true });
    return { ref, commit };
  } catch {
    return null;
  }
}

/** Copies the CURRENT contents of every file about to be written into a
 *  snapshot folder and records which of them did not previously exist. Throws
 *  on failure so an autonomous caller can refuse to write rather than write
 *  without a way back. */
export async function snapshotBeforeWrite(
  projectRoot: string,
  relativePaths: string[],
  snapshotRootDir: string
): Promise<ProjectSnapshot> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const snapshotDir = join(snapshotRootDir, id);
  await mkdir(snapshotDir, { recursive: true });

  const root = resolve(projectRoot);
  const entries: SnapshotEntry[] = [];

  for (const relativePath of relativePaths) {
    const source = resolve(root, relativePath);
    const present = await exists(source);
    if (present) {
      const destination = join(snapshotDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    entries.push({ relativePath, createdByRun: !present });
  }

  const snapshot: ProjectSnapshot = {
    id,
    createdAt: new Date().toISOString(),
    projectRoot: root,
    snapshotDir,
    entries
  };

  if (await isGitRepo(root)) {
    const git = await createGitSnapshot(root, id);
    if (git) {
      snapshot.gitRef = git.ref;
      snapshot.gitCommit = git.commit;
    }
  }

  await writeFile(join(snapshotDir, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}

/** Puts every file in a snapshot back the way it was. Files the run CREATED
 *  are not deleted here - reverting content is safe and reversible, deleting
 *  a file the user may have since edited is not. The caller surfaces the
 *  created list so a human can decide. Returns the paths actually restored. */
export async function revertSnapshot(snapshot: ProjectSnapshot): Promise<string[]> {
  const restored: string[] = [];
  for (const entry of snapshot.entries) {
    if (entry.createdByRun) continue;
    const backup = join(snapshot.snapshotDir, entry.relativePath);
    if (!(await exists(backup))) continue;
    const target = resolve(snapshot.projectRoot, entry.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(backup, target);
    restored.push(entry.relativePath);
  }
  return restored;
}

/** One human-readable line for the run timeline, telling the owner their
 *  work is recoverable and exactly how. Honest about which layers exist. */
export function describeSnapshot(snapshot: ProjectSnapshot): string {
  const changed = snapshot.entries.filter((entry) => !entry.createdByRun).length;
  const created = snapshot.entries.length - changed;
  const parts: string[] = [];
  if (changed > 0) parts.push(`backed up ${changed} existing file${changed === 1 ? "" : ""}`);
  if (created > 0) parts.push(`${created} file${created === 1 ? "" : "s"} will be new`);
  const gitNote = snapshot.gitRef ? `, and recorded a git snapshot at ${snapshot.gitRef}` : "";
  return `Safety net: ${parts.join(", ")}${gitNote}. Revert from Settings if this goes wrong.`;
}

/** Reads a snapshot descriptor back off disk (for the revert path). */
export async function readSnapshot(snapshotDir: string): Promise<ProjectSnapshot | null> {
  try {
    const raw = await readFile(join(snapshotDir, "snapshot.json"), "utf8");
    return JSON.parse(raw) as ProjectSnapshot;
  } catch {
    return null;
  }
}
