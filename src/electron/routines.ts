/** Routines, lifted out of main.ts.
 *
 *  Third carve of docs/STRUCTURAL_DEBT.md item 1, and the cleanest seam in the
 *  file: 257 lines that need exactly **four** things from main.ts. The scheduler
 *  is self-contained by construction — a routine is a saved prompt on a timer,
 *  and everything about deciding WHEN lives here while everything about running
 *  one is a single injected call.
 *
 *  Dependencies are injected rather than imported, for the same reason the
 *  gateway's and the loop runtime's are: importing them would make
 *  `main -> routines -> main`.
 */

import { randomUUID } from "node:crypto";
import type { AuditEvent, Routine } from "../shared/runtime-contracts.js";

/** The four. `runSessionTracked` is the whole of "run the routine"; the rest is
 *  persistence, the audit trail, and keeping the tray label honest. */
export interface RoutineDeps {
  appendAudit: (level: AuditEvent["level"], kind: string, summary: string, metadata?: Record<string, unknown>) => Promise<AuditEvent>;
  writeStoreValue: <T>(key: string, value: T) => Promise<void>;
  readStoreValue: <T>(key: string, fallback: T) => Promise<T>;
  runSessionTracked: (input: any, stream?: any) => Promise<any>;
  refreshTrayMenu: () => Promise<void> | void;
}

let injected: RoutineDeps | null = null;

/** Wire the routine scheduler. Called once from main.ts, before it can start. */
export function configureRoutines(deps: RoutineDeps): void {
  injected = deps;
}

function need(): RoutineDeps {
  if (!injected) throw new Error("Routines were used before configureRoutines() ran.");
  return injected;
}

// ---------------------------------------------------------------------------
// Routines (docs/FABLE_PLANS.md section 12) — a routine is a saved prompt that
// runs automatically on a schedule, with results landing in a dedicated
// conversation per routine. A single setTimeout chain drives the scheduler;
// it recomputes the soonest due routine after every fire (or store change) so
// there is never more than one timer live at once, and sleeps are capped at
// 60s slices so the chain self-corrects across system sleep/clock drift
// instead of trusting one long-lived timer to fire at the right wall-clock
// moment.
let routineTimer: ReturnType<typeof setTimeout> | undefined;
let routineTickRunning = false;

// Tray "Pause background work" state (persisted so it survives restarts).
// Cached in memory after first read; BOTH scheduler chains check this flag
// before firing anything due, so a pause genuinely stops background runs
// rather than just hiding them in the UI.
//
// The store key is still "routinesPaused" for back-compat with anyone who has
// already toggled it, but the meaning is now every unattended chain: routines
// AND loops. It used to cover routines only, which made the tray a half-truth -
// it reported "routines paused" while a loop carried on spending money in the
// background, and a pause switch that leaves the most autonomous thing in the
// app running is worse than no switch at all, because it is trusted.
let routinesPausedCache: boolean | undefined;

export async function isRoutinesPaused(): Promise<boolean> {
  if (routinesPausedCache === undefined) {
    routinesPausedCache = await need().readStoreValue<boolean>("routinesPaused", false);
  }
  return routinesPausedCache;
}

export async function setRoutinesPaused(paused: boolean): Promise<void> {
  routinesPausedCache = paused;
  await need().writeStoreValue("routinesPaused", paused);
  need().refreshTrayMenu();
}

async function readRoutines(): Promise<Routine[]> {
  return need().readStoreValue<Routine[]>("routines", []);
}

async function writeRoutines(routines: Routine[]): Promise<void> {
  await need().writeStoreValue("routines", routines);
}

function startOfMinute(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

/** Computes the next fire time for a routine's schedule, relative to `from`.
 *  interval: lastRunAt (or now) + N minutes. daily/weekly: the next occurrence
 *  of the given wall-clock time, rolling forward a day/week if it has already
 *  passed today/this-week. Weekday 0 = Sunday (JS convention). */
export function computeNextRunAt(routine: Routine, from: Date = new Date()): string {
  const schedule = routine.schedule;
  if (schedule.kind === "interval") {
    const base = routine.lastRunAt ? new Date(routine.lastRunAt) : from;
    const next = new Date(base.getTime() + Math.max(1, schedule.everyMinutes) * 60_000);
    return next < from ? new Date(from.getTime() + Math.max(1, schedule.everyMinutes) * 60_000).toISOString() : next.toISOString();
  }
  if (schedule.kind === "daily") {
    const next = startOfMinute(from);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  // weekly
  const next = startOfMinute(from);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  let dayDelta = schedule.weekday - next.getDay();
  if (dayDelta < 0) dayDelta += 7;
  next.setDate(next.getDate() + dayDelta);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next.toISOString();
}

export async function listRoutines(): Promise<Routine[]> {
  return readRoutines();
}

export async function saveRoutine(input: Routine): Promise<Routine> {
  const current = await readRoutines();
  const existingIndex = current.findIndex((routine) => routine.id === input.id);
  const base: Routine =
    existingIndex >= 0
      ? { ...current[existingIndex], ...input }
      : { ...input, id: input.id || randomUUID(), createdAt: input.createdAt || new Date().toISOString() };
  const saved: Routine = { ...base, nextRunAt: base.enabled ? computeNextRunAt(base) : undefined };
  const next = existingIndex >= 0 ? current.map((routine, index) => (index === existingIndex ? saved : routine)) : [saved, ...current];
  await writeRoutines(next);
  await need().appendAudit("info", "routine.save", `Saved routine "${saved.name}".`, { id: saved.id, enabled: saved.enabled });
  scheduleNextRoutineTick();
  return saved;
}

export async function deleteRoutine(id: string): Promise<Routine[]> {
  const current = await readRoutines();
  const routine = current.find((item) => item.id === id);
  const next = current.filter((item) => item.id !== id);
  await writeRoutines(next);
  if (routine) {
    await need().appendAudit("info", "routine.delete", `Deleted routine "${routine.name}".`, { id });
  }
  scheduleNextRoutineTick();
  return next;
}

/** Fires one routine: runs its prompt through the normal session pipeline
 *  (no streaming — routines execute unattended) and persists the result back
 *  onto the routine (lastRunAt/lastRunStatus/conversationId/nextRunAt). Any
 *  failure is caught so one bad routine can never wedge the scheduler chain. */
export async function fireRoutine(id: string): Promise<Routine | undefined> {
  const current = await readRoutines();
  const routine = current.find((item) => item.id === id);
  if (!routine) return undefined;

  await need().appendAudit("info", "routine.fire", `Firing routine "${routine.name}".`, { id: routine.id });

  const now = new Date().toISOString();
  let updated: Routine;
  try {
    const run = await need().runSessionTracked({
      prompt: routine.prompt,
      conversationId: routine.conversationId,
      projectPath: routine.projectPath,
      preset: routine.preset,
      rawPromptStorage: "local-only"
    });
    updated = {
      ...routine,
      lastRunAt: now,
      lastRunStatus: "ok",
      lastRunError: undefined,
      conversationId: run.conversationId ?? routine.conversationId
    };
    await need().appendAudit("info", "routine.complete", `Routine "${routine.name}" completed.`, {
      id: routine.id,
      conversationId: updated.conversationId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updated = {
      ...routine,
      lastRunAt: now,
      lastRunStatus: "error",
      lastRunError: message
    };
    await need().appendAudit("error", "routine.error", `Routine "${routine.name}" failed.`, {
      id: routine.id,
      error: message
    });
  }
  updated.nextRunAt = updated.enabled ? computeNextRunAt(updated, new Date(now)) : undefined;

  const afterFire = await readRoutines();
  const next = afterFire.map((item) => (item.id === updated.id ? updated : item));
  await writeRoutines(next);
  return updated;
}

export async function runRoutineNow(id: string): Promise<Routine | undefined> {
  const result = await fireRoutine(id);
  scheduleNextRoutineTick();
  return result;
}

/** Routine DRY RUN (docs/DRILL_PLAN.md I9.4): fires the routine's exact
 *  prompt once under permissionMode "plan" - the build pipeline stops after
 *  its plan stage and nothing is written, so the resulting conversation shows
 *  what the routine WOULD have done. Deliberately leaves the routine record
 *  completely untouched (no lastRunAt/nextRunAt/conversationId updates) and
 *  lands in a FRESH conversation rather than the routine's own thread, so a
 *  preview can never be mistaken for a real scheduled run. The prompt is
 *  passed verbatim so routing/classification matches the real firing. */
export async function dryRunRoutine(id: string): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
  const routine = (await readRoutines()).find((item) => item.id === id);
  if (!routine) return { ok: false, error: "Routine not found." };
  await need().appendAudit("info", "routine.dryrun", `Dry-running routine "${routine.name}" in plan mode.`, { id: routine.id });
  try {
    const run = await need().runSessionTracked({
      prompt: routine.prompt,
      projectPath: routine.projectPath,
      preset: routine.preset,
      permissionMode: "plan",
      rawPromptStorage: "local-only"
    });
    await need().appendAudit("info", "routine.dryrun", `Dry run of "${routine.name}" completed.`, {
      id: routine.id,
      conversationId: run.conversationId
    });
    return { ok: true, conversationId: run.conversationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await need().appendAudit("error", "routine.dryrun", `Dry run of "${routine.name}" failed.`, { id: routine.id, error: message });
    return { ok: false, error: message };
  }
}

/** The scheduler chain: finds the soonest enabled routine, sleeps until it is
 *  due (capped at 60s slices so a laptop sleep/wake or clock change is
 *  re-evaluated at least once a minute instead of oversleeping), fires every
 *  routine that is now due, then recomputes and reschedules itself. */
function scheduleNextRoutineTick(): void {
  if (routineTimer) {
    clearTimeout(routineTimer);
    routineTimer = undefined;
  }
  routineTimer = setTimeout(() => {
    void runRoutineTick();
  }, 60_000);
}

async function runRoutineTick(): Promise<void> {
  if (routineTickRunning) return;
  routineTickRunning = true;
  try {
    if (await isRoutinesPaused()) return;
    const routines = await readRoutines();
    const now = new Date();
    const due = routines.filter((routine) => routine.enabled && routine.nextRunAt && new Date(routine.nextRunAt) <= now);
    for (const routine of due) {
      await fireRoutine(routine.id);
    }
  } finally {
    routineTickRunning = false;
    scheduleNextRoutineTick();
  }
}

/** Called once on app.whenReady: recomputes nextRunAt for any routine missing
 *  it (e.g. created before the app last closed), fires any enabled routine
 *  whose nextRunAt is already in the past and opted into runOnLaunchIfMissed,
 *  then starts the recurring tick chain. */
export async function startRoutineScheduler(): Promise<void> {
  const routines = await readRoutines();
  const now = new Date();
  let mutated = false;
  const withNextRun = routines.map((routine) => {
    if (routine.enabled && !routine.nextRunAt) {
      mutated = true;
      return { ...routine, nextRunAt: computeNextRunAt(routine, now) };
    }
    return routine;
  });
  if (mutated) await writeRoutines(withNextRun);

  const missed = withNextRun.filter(
    (routine) => routine.enabled && routine.runOnLaunchIfMissed && routine.nextRunAt && new Date(routine.nextRunAt) <= now
  );
  for (const routine of missed) {
    await fireRoutine(routine.id);
  }
  scheduleNextRoutineTick();
}
