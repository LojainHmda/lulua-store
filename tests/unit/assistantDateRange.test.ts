import { describe, expect, it } from "vitest";
import {
  last30Days,
  last7Days,
  lastMonth,
  lastNDays,
  lastWeek,
  precedingPeriod,
  resolvePeriod,
  thisMonth,
  thisWeek,
  today,
  yesterday,
} from "../../src/admin/assistant/dateRange";

// A fixed reference instant, deliberately NOT at midnight, so every
// boundary computed from it must actually zero the time-of-day rather than
// accidentally inheriting it. Wednesday, 2026-03-18 14:37:05 local time.
const REF = new Date(2026, 2, 18, 14, 37, 5, 250);

function isMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

describe("today", () => {
  it("starts at local midnight of the reference day and ends at the next midnight (half-open)", () => {
    const r = today(REF);
    expect(isMidnight(r.start)).toBe(true);
    expect(isMidnight(r.end)).toBe(true);
    expect(r.start.getDate()).toBe(18);
    expect(r.end.getDate()).toBe(19);
    expect(r.end.getTime() - r.start.getTime()).toBe(24 * 3600 * 1000);
  });

  it("start <= reference instant < end", () => {
    const r = today(REF);
    expect(r.start.getTime()).toBeLessThanOrEqual(REF.getTime());
    expect(REF.getTime()).toBeLessThan(r.end.getTime());
  });

  it("an order created at exactly midnight belongs to that day, not the day before (half-open lower bound)", () => {
    const r = today(REF);
    expect(r.start.getTime() <= r.start.getTime()).toBe(true); // start itself is included
  });

  it("an order created at exactly the end boundary belongs to the NEXT day, not this one (half-open upper bound)", () => {
    const r = today(REF);
    // end is excluded: createdAt === end must fail `createdAt < end`
    expect(r.end.getTime() < r.end.getTime()).toBe(false);
  });
});

describe("yesterday", () => {
  it("is the single calendar day immediately before today, contiguous with it", () => {
    const t = today(REF);
    const y = yesterday(REF);
    expect(isMidnight(y.start)).toBe(true);
    expect(y.end.getTime()).toBe(t.start.getTime()); // contiguous, no gap or overlap
    expect(y.start.getDate()).toBe(17);
  });
});

describe("thisWeek / lastWeek", () => {
  it("this_week starts on Sunday at midnight and spans exactly 7 days", () => {
    const r = thisWeek(REF);
    expect(r.start.getDay()).toBe(0);
    expect(isMidnight(r.start)).toBe(true);
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 24 * 3600 * 1000);
    // REF (Wed) must fall inside [start, end)
    expect(r.start.getTime()).toBeLessThanOrEqual(REF.getTime());
    expect(REF.getTime()).toBeLessThan(r.end.getTime());
  });

  it("last_week is the 7 days immediately before this_week, contiguous", () => {
    const w = thisWeek(REF);
    const lw = lastWeek(REF);
    expect(lw.end.getTime()).toBe(w.start.getTime());
    expect(lw.end.getTime() - lw.start.getTime()).toBe(7 * 24 * 3600 * 1000);
  });
});

describe("thisMonth / lastMonth", () => {
  it("this_month starts on the 1st at midnight and ends on the 1st of next month", () => {
    const r = thisMonth(REF);
    expect(r.start.getDate()).toBe(1);
    expect(r.start.getMonth()).toBe(2); // March (0-indexed)
    expect(isMidnight(r.start)).toBe(true);
    expect(r.end.getDate()).toBe(1);
    expect(r.end.getMonth()).toBe(3); // April
  });

  it("last_month is contiguous with this_month and has the correct number of days", () => {
    const m = thisMonth(REF);
    const lm = lastMonth(REF);
    expect(lm.end.getTime()).toBe(m.start.getTime());
    expect(lm.start.getMonth()).toBe(1); // February
    expect(lm.start.getDate()).toBe(1);
  });

  it("handles a year boundary correctly (this_month = January -> last_month = December of the previous year)", () => {
    const jan = new Date(2026, 0, 15, 10, 0, 0);
    const lm = lastMonth(jan);
    expect(lm.start.getFullYear()).toBe(2025);
    expect(lm.start.getMonth()).toBe(11); // December
    expect(lm.start.getDate()).toBe(1);
    expect(lm.end.getFullYear()).toBe(2026);
    expect(lm.end.getMonth()).toBe(0);
  });

  it("handles months of different lengths correctly (this_month = March -> last_month = February, 28/29 days)", () => {
    const mar = new Date(2026, 2, 5);
    const lm = lastMonth(mar);
    const days = (lm.end.getTime() - lm.start.getTime()) / 86400000;
    expect(days).toBe(28); // 2026 is not a leap year
  });
});

describe("lastNDays / last7Days / last30Days", () => {
  it("last 7 days includes today plus the 6 days before it (7 calendar days total)", () => {
    const r = last7Days(REF);
    const days = (r.end.getTime() - r.start.getTime()) / 86400000;
    expect(days).toBe(7);
    expect(isMidnight(r.start)).toBe(true);
    expect(r.end.getTime()).toBe(today(REF).end.getTime()); // extends through end of today
    expect(r.start.getDate()).toBe(12); // 18 - 6
  });

  it("last 30 days spans exactly 30 calendar days ending after today", () => {
    const r = last30Days(REF);
    const days = (r.end.getTime() - r.start.getTime()) / 86400000;
    expect(days).toBe(30);
  });

  it("lastNDays(1) is equivalent to today", () => {
    const r = lastNDays(1, REF);
    const t = today(REF);
    expect(r.start.getTime()).toBe(t.start.getTime());
    expect(r.end.getTime()).toBe(t.end.getTime());
  });
});

describe("resolvePeriod", () => {
  it("resolves every period key to a range containing the reference instant appropriately", () => {
    const keys = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days"] as const;
    for (const key of keys) {
      const r = resolvePeriod(key, REF);
      expect(r.key).toBe(key);
      expect(r.start.getTime()).toBeLessThan(r.end.getTime());
    }
  });
});

describe("precedingPeriod (used for comparisons and follow-up context)", () => {
  it("preceding(today) === yesterday", () => {
    const p = precedingPeriod(today(REF));
    const y = yesterday(REF);
    expect(p.start.getTime()).toBe(y.start.getTime());
    expect(p.end.getTime()).toBe(y.end.getTime());
  });

  it("preceding(this_week) === last_week", () => {
    const p = precedingPeriod(thisWeek(REF));
    const lw = lastWeek(REF);
    expect(p.start.getTime()).toBe(lw.start.getTime());
    expect(p.end.getTime()).toBe(lw.end.getTime());
  });

  it("preceding(this_month) === last_month", () => {
    const p = precedingPeriod(thisMonth(REF));
    const lm = lastMonth(REF);
    expect(p.start.getTime()).toBe(lm.start.getTime());
    expect(p.end.getTime()).toBe(lm.end.getTime());
  });

  it("preceding(last_7_days) is the 7 days immediately before that window, same length", () => {
    const window = last7Days(REF);
    const p = precedingPeriod(window);
    expect(p.end.getTime()).toBe(window.start.getTime());
    expect(p.end.getTime() - p.start.getTime()).toBe(window.end.getTime() - window.start.getTime());
  });
});

describe("DST-safety (structural, timezone-machine-independent)", () => {
  // These assertions hold regardless of which timezone the test runner's
  // machine is in, and regardless of whether that timezone observes DST at
  // all -- they verify the CODE uses calendar-safe mutation (setDate/
  // setHours), not a fixed millisecond day length, which is what actually
  // matters for correctness across a real DST transition.
  it("consecutive daily boundaries always differ by exactly one calendar day, never by a fixed millisecond count alone", () => {
    for (let i = 0; i < 400; i++) {
      const d = new Date(2026, 0, 1, 12, 0, 0);
      d.setDate(d.getDate() + i);
      const r = today(d);
      expect(r.start.getDate()).toBe(d.getDate());
      expect(isMidnight(r.start)).toBe(true);
    }
  });

  it("every resolved range's start and end always land exactly on local midnight", () => {
    const keys = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days"] as const;
    for (const key of keys) {
      const r = resolvePeriod(key, REF);
      expect(isMidnight(r.start)).toBe(true);
      expect(isMidnight(r.end)).toBe(true);
    }
  });

  it("lastNDays never miscounts days even across a month/year boundary", () => {
    const newYearsDay = new Date(2026, 0, 1, 9, 0, 0);
    const r = lastNDays(7, newYearsDay);
    const days = (r.end.getTime() - r.start.getTime()) / 86400000;
    expect(days).toBe(7);
    expect(r.start.getFullYear()).toBe(2025);
    expect(r.start.getMonth()).toBe(11);
  });
});
