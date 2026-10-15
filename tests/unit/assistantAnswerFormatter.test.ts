import { describe, expect, it } from "vitest";
import { formatAssistantAnswer } from "../../src/admin/assistant/answerFormatter";
import { today } from "../../src/admin/assistant/dateRange";
import { translations, type Lang } from "../../src/i18n/translations";
import type { AssistantAnswer } from "../../src/admin/assistant/types";
import type { AdminOrder } from "../../src/admin/types";

// Mirrors LanguageContext.tsx's own lookup() exactly -- the formatter must
// work against the REAL translation tree, not a test-only stub.
function makeT(lang: Lang) {
  return (key: string): string => {
    const parts = key.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = translations[lang];
    for (const part of parts) node = node?.[part];
    return typeof node === "string" ? node : key;
  };
}

const tEn = makeT("en");
const tAr = makeT("ar");

function order(overrides: Partial<AdminOrder> = {}): AdminOrder {
  return {
    id: "o1",
    orderNumber: "SIS-TEST",
    customerName: "Sara",
    lines: [{ productId: "p1", variantId: "v1", name: "Dress", qty: 1, price: 100, size: "M", color: "Black" }],
    subtotal: 100,
    shipping: 0,
    total: 100,
    status: "delivered",
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("formatAssistantAnswer: sales_summary", () => {
  it("states the period, total sales, order count and average -- no invented numbers", () => {
    const answer: AssistantAnswer = {
      kind: "sales_summary",
      range: today(),
      messageKey: "admin.assistant.answer.salesSummary",
      data: { totals: { totalSales: 4250, orderCount: 18, averageOrderValue: 4250 / 18 }, confirmed: { totalSales: 0, orderCount: 0, averageOrderValue: null } },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toContain("Today");
    expect(text).toContain("4250.00");
    expect(text).toContain("18 orders");
  });

  it("uses the empty-orders phrasing rather than dividing by zero", () => {
    const answer: AssistantAnswer = {
      kind: "sales_summary",
      range: today(),
      messageKey: "admin.assistant.answer.salesSummary",
      data: { totals: { totalSales: 0, orderCount: 0, averageOrderValue: null }, confirmed: { totalSales: 0, orderCount: 0, averageOrderValue: null } },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toBe("Today — no orders were placed.");
  });

  it("appends the confirmed (delivered+completed) figure only when it has orders", () => {
    const answer: AssistantAnswer = {
      kind: "sales_summary",
      range: today(),
      messageKey: "admin.assistant.answer.salesSummary",
      data: { totals: { totalSales: 100, orderCount: 1, averageOrderValue: 100 }, confirmed: { totalSales: 100, orderCount: 1, averageOrderValue: 100 } },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toContain("Confirmed");
  });

  it("renders in Arabic when given the Arabic translation table", () => {
    const answer: AssistantAnswer = {
      kind: "sales_summary",
      range: today(),
      messageKey: "admin.assistant.answer.salesSummary",
      data: { totals: { totalSales: 100, orderCount: 2, averageOrderValue: 50 }, confirmed: { totalSales: 0, orderCount: 0, averageOrderValue: null } },
    };
    const text = formatAssistantAnswer(answer, tAr, "ar");
    expect(text).toContain("اليوم");
    expect(text).toContain("طلب");
  });

  it("marks a truncated (capped) read honestly rather than presenting it as complete", () => {
    const answer: AssistantAnswer = {
      kind: "sales_summary",
      range: today(),
      truncated: true,
      messageKey: "admin.assistant.answer.salesSummary",
      data: { totals: { totalSales: 100, orderCount: 1, averageOrderValue: 100 }, confirmed: { totalSales: 0, orderCount: 0, averageOrderValue: null } },
    };
    expect(formatAssistantAnswer(answer, tEn, "en")).toContain("most-recent slice");
  });
});

describe("formatAssistantAnswer: order_lookup / not_found / clarification", () => {
  it("includes order number, customer, status, total and prep progress -- no extra PII", () => {
    const answer: AssistantAnswer = {
      kind: "order_lookup",
      messageKey: "admin.assistant.answer.orderLookup",
      data: { order: order(), itemCount: 1, preparedCount: 0, totalLines: 1 },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toContain("SIS-TEST");
    expect(text).toContain("Sara");
    expect(text).toContain("100.00");
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no IP-looking data
  });

  it("states an explicit not-found rather than implying the order doesn't exist at all", () => {
    const answer: AssistantAnswer = { kind: "not_found", messageKey: "admin.assistant.answer.orderNotFound", data: { fragment: "9999", scanned: 500 } };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toContain("9999");
    expect(text).toContain("500");
  });

  it("asks for the full order number on ambiguity, never silently picks one", () => {
    const answer: AssistantAnswer = { kind: "clarification", messageKey: "admin.assistant.answer.orderAmbiguous" };
    expect(formatAssistantAnswer(answer, tEn, "en")).toMatch(/more than one/i);
  });
});

describe("formatAssistantAnswer: customer_history", () => {
  it("labels a guest match as a possible match, never asserted as certain", () => {
    const answer: AssistantAnswer = {
      kind: "customer_history",
      messageKey: "admin.assistant.answer.customerHistory",
      data: {
        summary: { totalOrders: 2, statusCounts: {}, successfulCount: 1, successfulSpend: 100, averageSuccessfulOrderValue: 100, firstOrderAt: null, lastOrderAt: null, nonDeliveryFlaggedCount: 0, returnedOrderCount: null, isRepeatCustomer: true, cancelledCount: 0, cancellationRatio: 0 },
        customerName: "Sara",
        isGuestMatch: true,
      },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toMatch(/possible match/i);
  });

  it("never invents a returned-items line when returnedOrderCount is null (unknown, not zero)", () => {
    const answer: AssistantAnswer = {
      kind: "customer_history",
      messageKey: "admin.assistant.answer.customerHistory",
      data: {
        summary: { totalOrders: 1, statusCounts: {}, successfulCount: 1, successfulSpend: 100, averageSuccessfulOrderValue: 100, firstOrderAt: null, lastOrderAt: null, nonDeliveryFlaggedCount: 0, returnedOrderCount: null, isRepeatCustomer: false, cancelledCount: 0, cancellationRatio: 0 },
        customerName: "Sara",
        isGuestMatch: false,
      },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).not.toMatch(/returned/i);
    expect(text).not.toMatch(/possible match/i);
  });
});

describe("formatAssistantAnswer: top lists", () => {
  it("lists ranked items with revenue for products", () => {
    const answer: AssistantAnswer = {
      kind: "top_product",
      range: today(),
      messageKey: "admin.assistant.answer.topProduct",
      data: { result: { items: [{ productId: "p1", name: "Dress", qty: 5, revenue: 500 }], tiedForFirst: false } },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toContain("Dress");
    expect(text).toContain("5 units");
    expect(text).toContain("500.00");
  });

  it("notes a tie for first place rather than arbitrarily picking a winner", () => {
    const answer: AssistantAnswer = {
      kind: "top_product",
      range: today(),
      messageKey: "admin.assistant.answer.topProduct",
      data: {
        result: {
          items: [
            { productId: "p1", name: "Dress", qty: 5, revenue: 500 },
            { productId: "p2", name: "Sandals", qty: 5, revenue: 300 },
          ],
          tiedForFirst: true,
        },
      },
    };
    expect(formatAssistantAnswer(answer, tEn, "en")).toMatch(/tied/i);
  });

  it("uses the empty-results phrasing when there are zero sales in the period", () => {
    const answer: AssistantAnswer = {
      kind: "top_color",
      range: today(),
      messageKey: "admin.assistant.answer.topColor",
      data: { result: { items: [], tiedForFirst: false }, unknownQty: 0 },
    };
    expect(formatAssistantAnswer(answer, tEn, "en")).toBe("Today — no color sales.");
  });

  it("surfaces unknownQty as an honest caveat rather than silently omitting it", () => {
    const answer: AssistantAnswer = {
      kind: "top_size",
      range: today(),
      messageKey: "admin.assistant.answer.topSize",
      data: { result: { items: [{ size: "M", qty: 3 }], tiedForFirst: false }, unknownQty: 2 },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).toContain("2 unit(s) excluded");
  });
});

describe("formatAssistantAnswer: comparison", () => {
  it("states both periods' facts and a plain difference, with no evaluative language", () => {
    const a = today();
    const b = today();
    const answer: AssistantAnswer = {
      kind: "comparison",
      messageKey: "admin.assistant.answer.comparison",
      data: {
        rangeA: a,
        rangeB: b,
        comparison: { a: { totalSales: 200, orderCount: 2, averageOrderValue: 100 }, b: { totalSales: 100, orderCount: 1, averageOrderValue: 100 }, salesDifference: 100, salesPercentChange: 1, orderCountDifference: 1 },
      },
    };
    const text = formatAssistantAnswer(answer, tEn, "en");
    expect(text).not.toMatch(/better|worse|good|bad|strong|weak/i);
    expect(text).toContain("100.00");
    expect(text).toContain("100.0%");
  });

  it("shows n/a for percent change rather than dividing by zero when the base period had no sales", () => {
    const a = today();
    const b = today();
    const answer: AssistantAnswer = {
      kind: "comparison",
      messageKey: "admin.assistant.answer.comparison",
      data: {
        rangeA: a,
        rangeB: b,
        comparison: { a: { totalSales: 100, orderCount: 1, averageOrderValue: 100 }, b: { totalSales: 0, orderCount: 0, averageOrderValue: null }, salesDifference: 100, salesPercentChange: null, orderCountDifference: 1 },
      },
    };
    expect(formatAssistantAnswer(answer, tEn, "en")).toContain("n/a");
  });
});

describe("formatAssistantAnswer: unsupported / error", () => {
  it("gives a concise, translated non-answer for unsupported questions -- never a guess", () => {
    const text = formatAssistantAnswer({ kind: "unsupported", messageKey: "admin.assistant.answer.unsupported" }, tEn, "en");
    expect(text).toMatch(/can't help|fixed set/i);
  });

  it("gives a distinct error message for a failed read, never confused with a zero-result answer", () => {
    const text = formatAssistantAnswer({ kind: "error", messageKey: "admin.assistant.answer.error" }, tEn, "en");
    expect(text).toMatch(/went wrong/i);
  });
});
