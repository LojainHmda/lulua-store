import { describe, expect, it } from "vitest";
import { extractPeriod, parseIntent } from "../../src/admin/assistant/intentParser";

describe("sales_summary", () => {
  const cases: [string, string | undefined][] = [
    ["شو مبيعات اليوم؟", "today"],
    ["كم مبيعات اليوم؟", "today"],
    ["شو مبيعات مبارح؟", "yesterday"],
    ["كم كانت المبيعات هذا الأسبوع؟", "this_week"],
    ["شو مبيعات هذا الشهر؟", "this_month"],
    ["كم بعنا آخر 7 أيام؟", "last_7_days"],
    ["كم بعنا آخر 30 يوم؟", "last_30_days"],
    ["What are today's sales?", "today"],
    ["How much did we sell today?", "today"],
    ["What were yesterday's sales?", "yesterday"],
    ["How much did we sell this week?", "this_week"],
    ["What are this month's sales?", "this_month"],
    ["How much did we sell in the last 7 days?", "last_7_days"],
    ["How much did we sell in the last 30 days?", "last_30_days"],
  ];
  for (const [q, period] of cases) {
    it(`recognizes: "${q}"`, () => {
      const intent = parseIntent(q);
      expect(intent.kind).toBe("sales_summary");
      expect(intent.period).toBe(period);
    });
  }
});

describe("daily_summary", () => {
  const cases = ["شو عندي اليوم؟", "شو وضع اليوم؟", "ملخص اليوم؟", "كيف اليوم؟", "What's happening today?", "Today's summary", "Give me today's summary"];
  for (const q of cases) {
    it(`recognizes: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("daily_summary");
    });
  }
});

describe("status_count", () => {
  const cases: [string, string][] = [
    ["كم طلب بانتظار التجهيز؟", "pending"],
    ["كم طلب جاري التحضير؟", "processing"],
    ["كم طلب تم تجهيزه؟", "ready"],
    ["كم طلب بالطريق؟", "shipped"],
    ["كم طلب تم تسليمه؟", "delivered"],
    ["كم طلب ملغي؟", "cancelled"],
    ["كم طلب مرتجع؟", "refunded"],
    ["How many orders are pending?", "pending"],
    ["How many orders are being prepared?", "processing"],
    ["How many orders are ready?", "ready"],
    ["How many orders are shipped?", "shipped"],
    ["How many orders are delivered?", "delivered"],
    ["How many orders are cancelled?", "cancelled"],
    ["How many orders are refunded?", "refunded"],
  ];
  for (const [q, status] of cases) {
    it(`recognizes: "${q}"`, () => {
      const intent = parseIntent(q);
      expect(intent.kind).toBe("status_count");
      expect(intent.status).toBe(status);
    });
  }
});

describe("order_lookup", () => {
  const cases = [
    "الطلبية 6556 شو صار فيها؟",
    "شو وضع طلب 6556؟",
    "وين وصلت الطلبية 6556؟",
    "What happened to order 6556?",
    "What's the status of order 6556?",
  ];
  for (const q of cases) {
    it(`recognizes: "${q}"`, () => {
      const intent = parseIntent(q);
      expect(intent.kind).toBe("order_lookup");
      expect(intent.orderFragment).toBe("6556");
    });
  }

  it("recognizes an explicit SIS- order number", () => {
    const intent = parseIntent("what is the status of SIS-LR3K9F2A");
    expect(intent.kind).toBe("order_lookup");
    expect(intent.orderFragment).toBe("SIS-LR3K9F2A");
  });

  it("does not misfire on a bare number with no order context", () => {
    const intent = parseIntent("6556");
    expect(intent.kind).not.toBe("order_lookup");
  });
});

describe("customer_history", () => {
  const cases = ["طلبات فلانة شو صار فيها؟", "شو وضع طلبات فلانة؟", "أعطيني تاريخ طلبات فلانة", "كم طلب عند فلانة؟"];
  for (const q of cases) {
    it(`recognizes: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("customer_history");
    });
  }

  it("extracts an email when present", () => {
    const intent = parseIntent("customer history for sara@example.com");
    expect(intent.kind).toBe("customer_history");
    expect(intent.customerQuery).toBe("sara@example.com");
  });

  it("extracts a phone number when present", () => {
    const intent = parseIntent("how many orders does 0501234567 have");
    expect(intent.kind).toBe("customer_history");
    expect(intent.customerQuery).toBe("0501234567");
  });

  it("does not require an explicit email/phone to recognize the intent (resolution happens downstream)", () => {
    const intent = parseIntent("How many orders does Sara have?");
    expect(intent.kind).toBe("customer_history");
  });
});

describe("top_product / top_category / top_color / top_size", () => {
  const productCases = ["شو أكتر منتج انباع؟", "أكثر منتج مبيعًا؟", "شو المنتج اللي باع أكثر؟", "شو أكتر منتج انباع آخر 7 أيام؟", "شو أكتر منتج انباع هذا الشهر؟"];
  for (const q of productCases) {
    it(`recognizes top_product: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("top_product");
    });
  }
  it("carries the period for a period-qualified top-product question", () => {
    const intent = parseIntent("شو أكتر منتج انباع آخر 7 أيام؟");
    expect(intent.period).toBe("last_7_days");
  });

  const categoryCases = ["شو أكتر تصنيف انباع؟", "أي تصنيف باع أكثر؟", "أكثر فئة مبيعًا؟", "Which category sold the most?"];
  for (const q of categoryCases) {
    it(`recognizes top_category: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("top_category");
    });
  }

  const colorCases = ["شو أكثر لون انباع؟", "أي لون باع أكثر؟", "Which color sold the most?"];
  for (const q of colorCases) {
    it(`recognizes top_color: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("top_color");
    });
  }

  const sizeCases = ["شو أكثر قياس انباع؟", "أي قياس باع أكثر؟", "Which size sold the most?"];
  for (const q of sizeCases) {
    it(`recognizes top_size: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("top_size");
    });
  }
});

describe("units_sold", () => {
  const cases = ["كم قطعة انباعت اليوم؟", "كم وحدة انباعت آخر أسبوع؟", "How many items were sold this week?"];
  for (const q of cases) {
    it(`recognizes: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("units_sold");
    });
  }
});

describe("zone_orders / zone_sales", () => {
  it('recognizes "which delivery zone has the most orders" as an aggregate zone_orders question', () => {
    expect(parseIntent("Which delivery zone has the most orders?").kind).toBe("zone_orders");
  });
  it('recognizes "أي منطقة جابت أكثر طلبات" as an aggregate zone question', () => {
    expect(parseIntent("أي منطقة جابت أكثر طلبات؟").kind).toBe("zone_orders");
  });
  it('recognizes "أي منطقة فيها أعلى مبيعات" as an aggregate zone_sales question', () => {
    expect(parseIntent("أي منطقة فيها أعلى مبيعات؟").kind).toBe("zone_sales");
  });
  it('recognizes a specific-zone order-count question and extracts the zone fragment', () => {
    const intent = parseIntent("How many orders are in Nablus?");
    expect(intent.kind).toBe("zone_orders");
    expect(intent.zoneFragment).toBe("Nablus");
  });
});

describe("out_of_stock / low_stock", () => {
  it('recognizes "شو المنتجات اللي خلصت"', () => {
    expect(parseIntent("شو المنتجات اللي خلصت؟").kind).toBe("out_of_stock");
  });
  it('recognizes "أي منتجات مخزونها صفر"', () => {
    expect(parseIntent("أي منتجات مخزونها صفر؟").kind).toBe("out_of_stock");
  });
  it('recognizes "Which products are out of stock?"', () => {
    expect(parseIntent("Which products are out of stock?").kind).toBe("out_of_stock");
  });
  it('recognizes a low-stock question', () => {
    expect(parseIntent("Which products are low in stock?").kind).toBe("low_stock");
  });
});

describe("comparison", () => {
  it('recognizes "مبيعات اليوم مقارنة بمبارح" with both periods extracted', () => {
    const intent = parseIntent("مبيعات اليوم مقارنة بمبارح");
    expect(intent.kind).toBe("comparison");
    expect(intent.period).toBe("today");
    expect(intent.comparePeriod).toBe("yesterday");
  });
  it('recognizes the colloquial "اليوم ولا مبارح؟"', () => {
    const intent = parseIntent("اليوم ولا مبارح؟");
    expect(intent.kind).toBe("comparison");
  });
  it('recognizes "هذا الأسبوع مقارنة بالأسبوع الماضي"', () => {
    const intent = parseIntent("هذا الأسبوع مقارنة بالأسبوع الماضي");
    expect(intent.kind).toBe("comparison");
    expect(intent.period).toBe("this_week");
    expect(intent.comparePeriod).toBe("last_week");
  });
  it('recognizes "Compare this month with last month."', () => {
    const intent = parseIntent("Compare this month with last month.");
    expect(intent.kind).toBe("comparison");
    expect(intent.period).toBe("this_month");
    expect(intent.comparePeriod).toBe("last_month");
  });
});

describe("unsupported", () => {
  const cases = [
    "ليش المبيعات نزلت؟",
    "why are sales down?",
    "predict next month's sales",
    "who will buy this product?",
    "what should I do?",
    "give me a marketing strategy",
    "asdkjhaskdjh random gibberish text",
  ];
  for (const q of cases) {
    it(`does NOT map to a supported intent: "${q}"`, () => {
      expect(parseIntent(q).kind).toBe("unsupported");
    });
  }

  it("an empty query is unsupported, not a crash", () => {
    expect(parseIntent("").kind).toBe("unsupported");
    expect(parseIntent("   ").kind).toBe("unsupported");
  });
});

describe("safety: unsupported questions never accidentally map to a supported intent", () => {
  it('"why are sales down" does not become sales_summary just because it contains "sales"', () => {
    expect(parseIntent("why are sales down?").kind).toBe("unsupported");
    expect(parseIntent("ليش المبيعات نزلت؟").kind).toBe("unsupported");
  });
  it('"predict next month\'s sales" does not become sales_summary', () => {
    expect(parseIntent("predict next month's sales").kind).toBe("unsupported");
  });
});

describe("extractPeriod", () => {
  it("returns null when no period is mentioned", () => {
    expect(extractPeriod("hello there")).toBeNull();
  });
  it("recognizes every supported period phrase in both languages", () => {
    expect(extractPeriod("today")).toBe("today");
    expect(extractPeriod("اليوم")).toBe("today");
    expect(extractPeriod("yesterday")).toBe("yesterday");
    expect(extractPeriod("مبارح")).toBe("yesterday");
    expect(extractPeriod("this week")).toBe("this_week");
    expect(extractPeriod("هذا الأسبوع")).toBe("this_week");
    expect(extractPeriod("last week")).toBe("last_week");
    expect(extractPeriod("الأسبوع الماضي")).toBe("last_week");
    expect(extractPeriod("this month")).toBe("this_month");
    expect(extractPeriod("هذا الشهر")).toBe("this_month");
    expect(extractPeriod("last month")).toBe("last_month");
    expect(extractPeriod("الشهر الماضي")).toBe("last_month");
    expect(extractPeriod("last 7 days")).toBe("last_7_days");
    expect(extractPeriod("آخر 7 أيام")).toBe("last_7_days");
    expect(extractPeriod("last 30 days")).toBe("last_30_days");
    expect(extractPeriod("آخر 30 يوم")).toBe("last_30_days");
  });
});
