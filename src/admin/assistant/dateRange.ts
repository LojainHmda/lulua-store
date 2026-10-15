// Shared date-boundary utility for the Sisely Assistant (see
// src/admin/assistant/README-equivalent comments throughout this module).
//
// V1 deliberately uses the ADMIN'S OWN BROWSER-LOCAL calendar/time, via
// plain `Date` getters/setters -- matching the only real precedent that
// exists (Reports.tsx's 14-day chart, which zeroes time-of-day with
// `setHours(0,0,0,0)` in local time). There is no server, no Cloud
// Function, and no timezone library anywhere in this codebase (confirmed:
// no date-fns/dayjs/luxon/moment dependency), so introducing a
// server/UTC-normalized notion of "today" here would be a NEW timezone
// system, not a reuse of an existing one -- exactly what we were told not
// to do. If Sisely ever needs a server-side, timezone-independent "today"
// (e.g. for a Cloud Function), that is a separate, deliberate decision for
// a later phase, not something V1 should invent as a side effect.
//
// Boundary convention: every range is a HALF-OPEN interval, `start <=
// createdAt < end`, so it composes cleanly into a Firestore query as
// `where("createdAt", ">=", start)` + `where("createdAt", "<", end)` with
// no off-by-one risk at midnight (an order created at exactly 00:00:00.000
// belongs to the day it starts, never the day before).
//
// DST safety: every boundary is produced by mutating a `Date` via
// `setDate`/`setMonth`/`setHours(0,0,0,0)` -- calendar-aware local-time
// operations that JS's `Date` already resolves correctly across a DST
// transition (e.g. `setDate(d.getDate()+1)` always lands on "the same
// wall-clock moment tomorrow", whether that's 23 or 25 real hours away).
// This deliberately avoids the one DST-unsafe pattern already present
// elsewhere in the app (Reports.tsx's `Math.floor((Date.now() -
// date.getTime()) / 86400000)` raw-millisecond day bucketing) -- not fixed
// here (that would be an unrelated change to an existing screen), just not
// repeated in this new module.

export type AssistantPeriodKey =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days";

export interface AssistantDateRange {
  key: AssistantPeriodKey;
  /** Inclusive lower boundary, local time. */
  start: Date;
  /** Exclusive upper boundary, local time -- see module comment. */
  end: Date;
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + months);
  return r;
}

// Sunday-start week -- there is no existing "start of week" convention
// anywhere in the codebase to match (confirmed absent by the discovery
// audit), so this picks the common regional convention (Sunday) and
// exposes it as the one place that choice lives, rather than burying a
// magic `getDay()` offset in every caller.
function startOfWeek(d: Date): Date {
  const start = startOfDay(d);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function startOfMonth(d: Date): Date {
  const r = startOfDay(d);
  r.setDate(1);
  return r;
}

export function today(now: Date = new Date()): AssistantDateRange {
  const start = startOfDay(now);
  return { key: "today", start, end: addDays(start, 1) };
}

export function yesterday(now: Date = new Date()): AssistantDateRange {
  const end = startOfDay(now);
  return { key: "yesterday", start: addDays(end, -1), end };
}

export function thisWeek(now: Date = new Date()): AssistantDateRange {
  const start = startOfWeek(now);
  return { key: "this_week", start, end: addDays(start, 7) };
}

export function lastWeek(now: Date = new Date()): AssistantDateRange {
  const end = startOfWeek(now);
  return { key: "last_week", start: addDays(end, -7), end };
}

export function thisMonth(now: Date = new Date()): AssistantDateRange {
  const start = startOfMonth(now);
  return { key: "this_month", start, end: addMonths(start, 1) };
}

export function lastMonth(now: Date = new Date()): AssistantDateRange {
  const end = startOfMonth(now);
  return { key: "last_month", start: addMonths(end, -1), end };
}

// "Last N days" includes TODAY plus the (n-1) days before it -- e.g. "last
// 7 days" run on a Wednesday covers last Thursday through today inclusive.
// End is exclusive tomorrow-midnight, so it also captures anything created
// later today.
export function lastNDays(n: number, now: Date = new Date()): AssistantDateRange {
  const end = addDays(startOfDay(now), 1);
  const start = addDays(startOfDay(now), -(n - 1));
  return { key: n === 7 ? "last_7_days" : n === 30 ? "last_30_days" : "last_7_days", start, end };
}

export function last7Days(now: Date = new Date()): AssistantDateRange {
  return { ...lastNDays(7, now), key: "last_7_days" };
}

export function last30Days(now: Date = new Date()): AssistantDateRange {
  return { ...lastNDays(30, now), key: "last_30_days" };
}

const RESOLVERS: Record<AssistantPeriodKey, (now?: Date) => AssistantDateRange> = {
  today,
  yesterday,
  this_week: thisWeek,
  last_week: lastWeek,
  this_month: thisMonth,
  last_month: lastMonth,
  last_7_days: last7Days,
  last_30_days: last30Days,
};

export function resolvePeriod(key: AssistantPeriodKey, now: Date = new Date()): AssistantDateRange {
  return RESOLVERS[key](now);
}

// The period immediately preceding an equivalent-length period -- used for
// a bare "compare this week" with no second period named, and for
// follow-up context ("what about yesterday" after "sales today"). Not
// every period has a natural predecessor with an existing resolver
// (last_7_days/last_30_days are already rolling windows, comparing them
// against "the previous 7/30 days" is a real, well-defined range even
// though there's no named period for it) -- those two are computed
// directly here rather than added as new named periods nobody asked for.
export function precedingPeriod(range: AssistantDateRange): AssistantDateRange {
  switch (range.key) {
    case "today":
      return { key: "yesterday", start: new Date(range.start.getTime() - 86400000), end: range.start };
    case "yesterday":
      return { key: "yesterday", start: new Date(range.start.getTime() - 86400000), end: range.start };
    case "this_week":
      return { key: "last_week", start: new Date(range.start.getTime() - 7 * 86400000), end: range.start };
    case "last_week":
      return { key: "last_week", start: new Date(range.start.getTime() - 7 * 86400000), end: range.start };
    case "this_month": {
      const start = addMonths(range.start, -1);
      return { key: "last_month", start, end: range.start };
    }
    case "last_month": {
      const start = addMonths(range.start, -1);
      return { key: "last_month", start, end: range.start };
    }
    case "last_7_days":
    case "last_30_days": {
      const spanMs = range.end.getTime() - range.start.getTime();
      return { key: range.key, start: new Date(range.start.getTime() - spanMs), end: range.start };
    }
  }
}

// Human-readable label key (translated at the call site via t()) for
// stating "the interpreted period" in every answer -- see
// admin.assistant.period.* in translations.ts.
export function periodLabelKey(key: AssistantPeriodKey): string {
  return `admin.assistant.period.${key}`;
}
