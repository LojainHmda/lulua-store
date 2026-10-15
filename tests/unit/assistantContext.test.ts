import { describe, expect, it } from "vitest";
import { EMPTY_CONTEXT, parseIntentWithContext, updateContext } from "../../src/admin/assistant/context";
import { parseIntent } from "../../src/admin/assistant/intentParser";

describe("follow-up: sales today -> yesterday", () => {
  it('"شو مبيعات اليوم؟" then "ومبارح؟" reuses sales_summary with period=yesterday', () => {
    const first = parseIntentWithContext("شو مبيعات اليوم؟", EMPTY_CONTEXT);
    expect(first.kind).toBe("sales_summary");
    expect(first.period).toBe("today");

    const ctx = updateContext(first);
    const second = parseIntentWithContext("ومبارح؟", ctx);
    expect(second.kind).toBe("sales_summary");
    expect(second.period).toBe("yesterday");
  });

  it('"What are today\'s sales?" then "what about yesterday?" behaves the same in English', () => {
    const first = parseIntentWithContext("What are today's sales?", EMPTY_CONTEXT);
    const ctx = updateContext(first);
    const second = parseIntentWithContext("what about yesterday?", ctx);
    expect(second.kind).toBe("sales_summary");
    expect(second.period).toBe("yesterday");
  });
});

describe("follow-up: sales today -> orders?", () => {
  it('"شو مبيعات اليوم؟" then "وطلبات؟" switches to order_count for the same period', () => {
    const first = parseIntentWithContext("شو مبيعات اليوم؟", EMPTY_CONTEXT);
    const ctx = updateContext(first);
    const second = parseIntentWithContext("وطلبات؟", ctx);
    expect(second.kind).toBe("order_count");
    expect(second.period).toBe("today");
  });

  it('"sales today" then "orders?" switches to order_count in English too', () => {
    const first = parseIntentWithContext("sales today", EMPTY_CONTEXT);
    const ctx = updateContext(first);
    const second = parseIntentWithContext("orders?", ctx);
    expect(second.kind).toBe("order_count");
    expect(second.period).toBe("today");
  });
});

describe("no context / unrelated context", () => {
  it("a bare period with NO prior context stays unsupported (nothing to reuse)", () => {
    const result = parseIntentWithContext("ومبارح؟", EMPTY_CONTEXT);
    expect(result.kind).toBe("unsupported");
  });

  it("a directly-recognized intent never consults context at all", () => {
    const ctx = updateContext(parseIntent("مبيعات اليوم"));
    const result = parseIntentWithContext("كم طلب ملغي؟", ctx);
    expect(result.kind).toBe("status_count");
    expect(result.status).toBe("cancelled");
  });

  it("does not apply a period follow-up to an intent kind that can't sensibly reuse one (order_lookup)", () => {
    const orderLookupCtx = updateContext(parseIntent("الطلبية 6556 شو صار فيها؟"));
    const result = parseIntentWithContext("ومبارح؟", orderLookupCtx);
    // order_lookup isn't in PERIOD_REPEATABLE_INTENTS -- "and yesterday?"
    // makes no sense as a follow-up to a specific order lookup, so this
    // must stay unsupported rather than guessing an order_lookup for
    // "yesterday".
    expect(result.kind).toBe("unsupported");
  });

  it("a genuinely unsupported question resets context (does not silently answer a stale, unrelated follow-up)", () => {
    const ctx = updateContext(parseIntent("مبيعات اليوم"));
    const afterUnsupported = updateContext(parseIntent("why are sales down?"));
    expect(afterUnsupported).toEqual(EMPTY_CONTEXT);
    void ctx;
  });
});

describe("updateContext", () => {
  it("captures the intent kind and period of a successfully recognized intent", () => {
    const ctx = updateContext(parseIntent("مبيعات هذا الأسبوع"));
    expect(ctx.lastIntentKind).toBe("sales_summary");
    expect(ctx.lastPeriod).toBe("this_week");
  });

  it("resets to empty for an unsupported intent", () => {
    expect(updateContext(parseIntent("why?"))).toEqual(EMPTY_CONTEXT);
  });

  it("stores a null period for an intent that has none (e.g. order_lookup)", () => {
    const ctx = updateContext(parseIntent("الطلبية 6556 شو صار فيها؟"));
    expect(ctx.lastIntentKind).toBe("order_lookup");
    expect(ctx.lastPeriod).toBeNull();
  });
});
