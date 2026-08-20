// When a routine actually fires next.
//
// A routine is a saved prompt on a timer, and every bug this logic can have is
// a bug you find out about by something not running overnight — the worst kind
// to debug, because the evidence is an absence. Nothing tested it until the
// routines carve (docs/STRUCTURAL_DEBT.md item 1) put `computeNextRunAt` in a
// module that could be imported without electron.
//
// It takes `from` as an argument, which is the only reason this file can exist:
// a scheduler that read the clock internally could only be tested by waiting.
//
// Offline: no provider is called, no timer is armed, no API key is read.

import { fromBuild, section, check, ok, summary } from "../harness.mjs";

const { computeNextRunAt } = await fromBuild("electron/routines.js");

const routine = (schedule, extra = {}) => ({
  id: "r1",
  title: "test",
  prompt: "do the thing",
  enabled: true,
  schedule,
  ...extra
});

// Local time, because that is what the scheduler works in — a routine set for
// 9am means 9am where the person is.
const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const at = (iso) => new Date(iso);

section("Daily rolls over midnight rather than scheduling the past");
{
  const daily = routine({ kind: "daily", hour: 9, minute: 0 });

  const beforeToday = at(computeNextRunAt(daily, local(2026, 8, 20, 7, 30)));
  check("7:30am waits for 9am the same day", [beforeToday.getDate(), beforeToday.getHours()], [20, 9]);

  const afterToday = at(computeNextRunAt(daily, local(2026, 8, 20, 10, 0)));
  check("10am goes to 9am tomorrow", [afterToday.getDate(), afterToday.getHours()], [21, 9]);

  // The boundary. `next <= from` rolls forward, so asking AT the scheduled
  // minute gives tomorrow — correct, because this is called after a fire.
  const exactly = at(computeNextRunAt(daily, local(2026, 8, 20, 9, 0)));
  check("exactly 9:00 gives tomorrow, not a re-fire now", exactly.getDate(), 21);

  // Month and year rollover come free from setDate, and are worth pinning
  // because "free from the platform" is where off-by-one bugs hide.
  const monthEnd = at(computeNextRunAt(daily, local(2026, 8, 31, 23, 0)));
  check("the 31st rolls into next month", [monthEnd.getMonth() + 1, monthEnd.getDate()], [9, 1]);
  const yearEnd = at(computeNextRunAt(daily, local(2026, 12, 31, 23, 0)));
  check("new year's eve rolls into next year", [yearEnd.getFullYear(), yearEnd.getMonth() + 1, yearEnd.getDate()], [2027, 1, 1]);
}

section("Weekly finds the right weekday, including the wrap");
{
  // 2026-08-20 is a Thursday (getDay() === 4).
  const thursday = local(2026, 8, 20, 12, 0);
  check("the fixture really is a Thursday", thursday.getDay(), 4);

  const monday = at(computeNextRunAt(routine({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }), thursday));
  check("Monday from a Thursday wraps to next week", monday.getDay(), 1);
  ok("and is in the future", monday > thursday);

  const saturday = at(computeNextRunAt(routine({ kind: "weekly", weekday: 6, hour: 9, minute: 0 }), thursday));
  check("Saturday from a Thursday is this week", saturday.getDay(), 6);
  check("two days later", saturday.getDate(), 22);

  // Same weekday is the case the `dayDelta < 0` branch cannot cover on its own:
  // delta is 0, so the `next <= from` check is what pushes it a week out.
  const sameDayLater = at(computeNextRunAt(routine({ kind: "weekly", weekday: 4, hour: 18, minute: 0 }), thursday));
  check("same weekday, later hour, stays today", [sameDayLater.getDate(), sameDayLater.getHours()], [20, 18]);
  const sameDayEarlier = at(computeNextRunAt(routine({ kind: "weekly", weekday: 4, hour: 6, minute: 0 }), thursday));
  check("same weekday, earlier hour, goes a week out", sameDayEarlier.getDate(), 27);
}

section("Interval counts from the last run, and never schedules the past");
{
  const every30 = routine({ kind: "interval", everyMinutes: 30 });
  const now = local(2026, 8, 20, 12, 0);

  const fresh = at(computeNextRunAt(every30, now));
  check("with no lastRunAt it counts from now", fresh.getTime() - now.getTime(), 30 * 60_000);

  const recent = at(computeNextRunAt({ ...every30, lastRunAt: local(2026, 8, 20, 11, 50).toISOString() }, now));
  check("with a recent lastRunAt it counts from that", recent.getTime() - now.getTime(), 20 * 60_000);

  // THE ONE THAT MATTERS. A laptop that slept for a day comes back with a
  // lastRunAt far in the past; counting from it would schedule a time that has
  // already gone, and the routine would fire immediately and repeatedly rather
  // than settling onto its interval.
  const stale = at(computeNextRunAt({ ...every30, lastRunAt: local(2026, 8, 19, 3, 0).toISOString() }, now));
  ok("a day-old lastRunAt does not schedule the past", stale > now);
  check("it re-bases on now instead", stale.getTime() - now.getTime(), 30 * 60_000);

  // Zero and negative intervals are clamped rather than trusted: everyMinutes
  // comes off a stored record, and a 0 would be a busy loop with a timer in it.
  const zero = at(computeNextRunAt(routine({ kind: "interval", everyMinutes: 0 }), now));
  check("a zero interval is clamped to one minute", zero.getTime() - now.getTime(), 60_000);
  const negative = at(computeNextRunAt(routine({ kind: "interval", everyMinutes: -5 }), now));
  ok("and a negative one cannot schedule backwards", negative > now);
}

section("Every schedule kind returns a real instant");
{
  const now = local(2026, 8, 20, 12, 0);
  for (const schedule of [
    { kind: "interval", everyMinutes: 15 },
    { kind: "daily", hour: 0, minute: 0 },
    { kind: "weekly", weekday: 0, hour: 23, minute: 59 }
  ]) {
    const iso = computeNextRunAt(routine(schedule), now);
    ok(`${schedule.kind} produces a parseable ISO string`, !Number.isNaN(Date.parse(iso)));
    ok(`${schedule.kind} is in the future`, new Date(iso) > now);
  }
}

const { passed, failed } = summary();
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
