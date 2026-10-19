// Date-range filter shared by the admin POS pages (POS Sales, Returns):
// today / yesterday / last 7 days / this month / a custom from-to.
export type PosRange = "today" | "yesterday" | "7d" | "month" | "custom";

export const POS_RANGES: PosRange[] = ["today", "yesterday", "7d", "month", "custom"];

export function dayStart(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// [start, end) for the chosen range; `from`/`to` are yyyy-mm-dd (custom only).
export function rangeBounds(range: PosRange, from: string, to: string): { start: Date; end: Date } {
  const today = dayStart(new Date());
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  switch (range) {
    case "today":
      return { start: today, end };
    case "yesterday": {
      const s = new Date(today);
      s.setDate(s.getDate() - 1);
      return { start: s, end: today };
    }
    case "7d": {
      const s = new Date(today);
      s.setDate(s.getDate() - 6);
      return { start: s, end };
    }
    case "month":
      return { start: new Date(today.getFullYear(), today.getMonth(), 1), end };
    case "custom": {
      const s = from ? dayStart(new Date(`${from}T00:00:00`)) : today;
      const e = to ? dayStart(new Date(`${to}T00:00:00`)) : today;
      e.setDate(e.getDate() + 1);
      return { start: s, end: e };
    }
  }
}
