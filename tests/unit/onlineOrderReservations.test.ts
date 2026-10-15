import { describe, expect, it } from "vitest";
import {
  classifyStoreSaleAvailability,
  reservationsForLine,
  STOCK_RESERVING_ORDER_STATUSES,
} from "../../src/admin/onlineOrderReservations";
import type { OrderLine, OrderStatus } from "../../src/admin/types";

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return {
    productId: "p1",
    variantId: "v1",
    size: "M",
    qty: 1,
    name: "Blue Dress",
    color: "Blue",
    price: 100,
    ...overrides,
  };
}

function order(overrides: Partial<{ id: string; orderNumber: string; customerName: string; status: OrderStatus; lines: OrderLine[] }> = {}) {
  return {
    id: "o1",
    orderNumber: "SIS-001",
    customerName: "Jane Doe",
    status: "pending" as OrderStatus,
    lines: [line()],
    ...overrides,
  };
}

const TARGET = { productId: "p1", variantId: "v1", size: "M" };

describe("STOCK_RESERVING_ORDER_STATUSES", () => {
  it("is exactly pending, processing, ready -- see onlineOrderReservations.ts for the full traced reasoning", () => {
    expect([...STOCK_RESERVING_ORDER_STATUSES].sort()).toEqual(["pending", "processing", "ready"]);
  });

  it("never includes cancelled -- cancellation restores stock", () => {
    expect(STOCK_RESERVING_ORDER_STATUSES).not.toContain("cancelled");
  });

  it("never includes refunded -- a refunded order has necessarily already shipped (cancellation is the only path for pending/processing/ready), so its unit has already left the shelf, same as shipped/delivered/completed", () => {
    expect(STOCK_RESERVING_ORDER_STATUSES).not.toContain("refunded");
  });

  it("never includes shipped/delivered/completed -- those units have physically left the building per RETURNABLE_ORDER_STATUSES' own reasoning", () => {
    expect(STOCK_RESERVING_ORDER_STATUSES).not.toContain("shipped");
    expect(STOCK_RESERVING_ORDER_STATUSES).not.toContain("delivered");
    expect(STOCK_RESERVING_ORDER_STATUSES).not.toContain("completed");
  });
});

describe("reservationsForLine", () => {
  // Test 1 -- product with no active online orders.
  it("returns zero/empty when there are no orders at all", () => {
    const result = reservationsForLine([], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  it("returns zero/empty when orders exist but none touch this product/variant/size", () => {
    const result = reservationsForLine([order({ lines: [line({ productId: "other" })] })], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  // Test 2 -- product with one active order.
  it("reports a single contributing order with its exact qty", () => {
    const result = reservationsForLine([order({ id: "o1", orderNumber: "SIS-100", lines: [line({ qty: 2 })] })], TARGET);
    expect(result.reservedQty).toBe(2);
    expect(result.entries).toEqual([{ orderId: "o1", orderNumber: "SIS-100", customerName: "Jane Doe", status: "pending", qty: 2 }]);
  });

  // Test 3 -- product with multiple active orders: every contributing order
  // listed individually, not collapsed into a bare count.
  it("reports every contributing order individually when multiple orders reserve the same line", () => {
    const orders = [
      order({ id: "o1", orderNumber: "SIS-100", status: "processing", lines: [line({ qty: 1 })] }),
      order({ id: "o2", orderNumber: "SIS-101", status: "pending", lines: [line({ qty: 2 })] }),
    ];
    const result = reservationsForLine(orders, TARGET);
    expect(result.reservedQty).toBe(3);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.orderId).sort()).toEqual(["o1", "o2"]);
  });

  // Test 7 -- cancelled order does not reserve stock.
  it("ignores a cancelled order entirely", () => {
    const result = reservationsForLine([order({ status: "cancelled", lines: [line({ qty: 5 })] })], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  // Test 8 -- refunded order does not reserve stock (per this feature's own
  // reservation semantics -- see the module comment for why).
  it("ignores a refunded order entirely", () => {
    const result = reservationsForLine([order({ status: "refunded", lines: [line({ qty: 5 })] })], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  it("ignores shipped/delivered/completed orders -- their units have already left the building", () => {
    for (const status of ["shipped", "delivered", "completed"] as OrderStatus[]) {
      const result = reservationsForLine([order({ status, lines: [line({ qty: 5 })] })], TARGET);
      expect(result.reservedQty).toBe(0);
    }
  });

  it("counts ready orders -- the checklist status carries no stock effect of its own, the unit is still on-shelf-equivalent", () => {
    const result = reservationsForLine([order({ status: "ready", lines: [line({ qty: 3 })] })], TARGET);
    expect(result.reservedQty).toBe(3);
  });

  // Test 9 -- different variant does not create a false warning.
  it("does not match a different variant of the same product", () => {
    const result = reservationsForLine([order({ lines: [line({ variantId: "v2", qty: 9 })] })], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  // Test 10 -- different size does not create a false warning.
  it("does not match a different size of the same product/variant", () => {
    const result = reservationsForLine([order({ lines: [line({ size: "L", qty: 9 })] })], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  it("does not match a different product entirely", () => {
    const result = reservationsForLine([order({ lines: [line({ productId: "other", qty: 9 })] })], TARGET);
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  // Test 13 -- quantity aggregation across multiple lines for the same
  // product/variant/size within one order (the schema permits this -- e.g. a
  // manual order edited twice before checkout).
  it("sums multiple lines for the same product/variant/size within a single order", () => {
    const result = reservationsForLine([order({ id: "o1", orderNumber: "SIS-100", lines: [line({ qty: 2 }), line({ qty: 3 })] })], TARGET);
    expect(result.reservedQty).toBe(5);
    expect(result.entries).toEqual([{ orderId: "o1", orderNumber: "SIS-100", customerName: "Jane Doe", status: "pending", qty: 5 }]);
  });

  // The order currently being edited must never self-flag as a competing
  // online order.
  it("excludes the current order (currentOrderId) even if it already has a matching line", () => {
    const result = reservationsForLine([order({ id: "o1", lines: [line({ qty: 4 })] })], TARGET, "o1");
    expect(result).toEqual({ reservedQty: 0, entries: [] });
  });

  it("still counts a DIFFERENT order's reservation when a currentOrderId is given", () => {
    const orders = [order({ id: "o1", lines: [line({ qty: 4 })] }), order({ id: "o2", orderNumber: "SIS-200", lines: [line({ qty: 1 })] })];
    const result = reservationsForLine(orders, TARGET, "o1");
    expect(result.reservedQty).toBe(1);
    expect(result.entries).toEqual([{ orderId: "o2", orderNumber: "SIS-200", customerName: "Jane Doe", status: "pending", qty: 1 }]);
  });

  // Test 12 -- existing orders with missing/legacy fields do not crash the UI.
  it("does not throw on an order with no lines field at all", () => {
    // @ts-expect-error -- simulating a legacy/malformed document missing `lines`
    const malformed = { id: "o1", orderNumber: "SIS-100", customerName: "Jane Doe", status: "pending" };
    expect(() => reservationsForLine([malformed], TARGET)).not.toThrow();
    expect(reservationsForLine([malformed], TARGET)).toEqual({ reservedQty: 0, entries: [] });
  });

  it("does not throw and skips a line missing productId/variantId/size", () => {
    const orders = [
      order({
        lines: [
          // @ts-expect-error -- simulating a malformed/legacy line
          { qty: 5, name: "Mystery", color: "Blue", price: 10 },
          line({ qty: 2 }),
        ],
      }),
    ];
    expect(() => reservationsForLine(orders, TARGET)).not.toThrow();
    expect(reservationsForLine(orders, TARGET).reservedQty).toBe(2);
  });

  it("does not throw on a null/undefined entry in the orders array", () => {
    // @ts-expect-error -- defensive against a malformed array entry
    expect(() => reservationsForLine([null, order({ lines: [line({ qty: 2 })] })], TARGET)).not.toThrow();
  });

  it("does not mutate its inputs", () => {
    const orders = [order({ lines: [line({ qty: 2 })] })];
    const copy = JSON.parse(JSON.stringify(orders));
    reservationsForLine(orders, TARGET);
    expect(orders).toEqual(copy);
  });
});

describe("classifyStoreSaleAvailability -- CORRECTED formula: available === stock, never stock - reserved", () => {
  // placeOrder() already decrements `stock` by every reserving order's
  // claimed quantity at the moment each order is created -- see the module
  // comment above classifyStoreSaleAvailability for the full derivation.
  // `stock` therefore already excludes what's reserved; subtracting
  // `reserved` again would double-count it. These are the exact three
  // worked examples from the correction request.

  // Required scenario 1 -- one reserved unit out of an original 5 -> current
  // qty 4 -> store available 4 (NOT 4 - 1 = 3).
  it("Example A: stock 5 -> one order reserves 1 -> current qty 4 -> available 4", () => {
    expect(classifyStoreSaleAvailability(4, 1)).toEqual({ tier: "warning", stock: 4, reserved: 1, available: 4 });
  });

  // Required scenario 2 -- one reserved unit out of an original 1 -> current
  // qty 0 -> store available 0, blocked.
  it("Example B: stock 1 -> one order reserves 1 -> current qty 0 -> available 0, blocked", () => {
    expect(classifyStoreSaleAvailability(0, 1)).toEqual({ tier: "block", stock: 0, reserved: 1, available: 0 });
  });

  // Required scenario 4 -- multiple active orders reserving a combined
  // quantity: original 5, two orders totaling 2 -> current qty 3 -> available 3.
  it("Example C: stock 5 -> two orders reserve 1 each (2 total) -> current qty 3 -> available 3", () => {
    expect(classifyStoreSaleAvailability(3, 2)).toEqual({ tier: "warning", stock: 3, reserved: 2, available: 3 });
  });

  // Required scenario 3 -- multiple reserved units against a larger stock.
  it("stock 10 -> orders reserve 6 total -> current qty 4 -> available 4, still a warning (spare capacity remains)", () => {
    expect(classifyStoreSaleAvailability(4, 6)).toEqual({ tier: "warning", stock: 4, reserved: 6, available: 4 });
  });

  it("is 'safe' whenever nothing is reserved, regardless of stock level", () => {
    expect(classifyStoreSaleAvailability(5, 0)).toEqual({ tier: "safe", stock: 5, reserved: 0, available: 5 });
    expect(classifyStoreSaleAvailability(0, 0)).toEqual({ tier: "safe", stock: 0, reserved: 0, available: 0 });
    expect(classifyStoreSaleAvailability(null, 0)).toEqual({ tier: "safe", stock: null, reserved: 0, available: null });
  });

  it("is 'warning' whenever stock is still positive, however small, while something is reserved", () => {
    expect(classifyStoreSaleAvailability(1, 4)).toEqual({ tier: "warning", stock: 1, reserved: 4, available: 1 });
  });

  it("is 'block' only when current stock is exactly 0 while something is reserved -- never a negative 'available'", () => {
    expect(classifyStoreSaleAvailability(0, 1)).toEqual({ tier: "block", stock: 0, reserved: 1, available: 0 });
    expect(classifyStoreSaleAvailability(0, 5)).toEqual({ tier: "block", stock: 0, reserved: 5, available: 0 });
  });

  it("never returns a negative 'available', for any non-negative stock/reserved input", () => {
    for (const stock of [0, 1, 2, 5, 10]) {
      for (const reserved of [0, 1, 3, 5, 20]) {
        const result = classifyStoreSaleAvailability(stock, reserved);
        expect(result.available === null || result.available >= 0).toBe(true);
        expect(result.available).toBe(stock); // the corrected identity: available === stock, always
      }
    }
  });

  it("is 'block' for unconfirmed stock (null) with any real reservation, rather than claiming a specific available number", () => {
    expect(classifyStoreSaleAvailability(null, 3)).toEqual({ tier: "block", stock: null, reserved: 3, available: null });
  });
});

// Test 11 -- barcode and name-search paths resolve to the same underlying
// commitment result.
//
// HONEST SCOPE OF THIS TEST (tightened after adversarial review, which
// correctly pointed out an earlier version of this test proved nothing about
// the two real UI entry points): this project's test suite has no component-
// rendering harness (no @testing-library/react, no renderHook — confirmed
// absent from every existing test file), so there is no automated way to
// actually mount ProductAvailabilityCheckModal.tsx (src/admin/pages/orders/,
// opened from OrderList.tsx's toolbar) and drive both a simulated barcode
// scan and a simulated search-grid click through it. What THIS test can and
// does prove is that reservationsForLine() is a pure, deterministic function
// of its arguments (same product+variant+size in -> same result out, no
// hidden state). The actual "one code path, not two" guarantee is
// structural, not test-enforced: both that component's handleScan() and its
// search-grid tiles' onClick call the exact same selectProduct() (verified
// by direct code reading), which is the only place
// selectedProduct/variantId/size are set, and lineReservation/availability
// are computed from those in exactly one place. If a future change ever made
// handleScan() bypass selectProduct() and set that state some other way,
// this pure-function test would NOT catch the resulting divergence -- that
// residual gap is called out explicitly in the implementation report rather
// than papered over by a misleadingly-named test.
describe("barcode vs. search path equivalence (pure-function determinism only -- see comment above)", () => {
  it("reservationsForLine is deterministic: the same product/variant/size input always produces the same result", () => {
    const orders = [order({ lines: [line({ qty: 2 })] })];
    const viaFirstCall = reservationsForLine(orders, TARGET);
    const viaSecondCall = reservationsForLine(orders, TARGET);
    expect(viaFirstCall).toEqual(viaSecondCall);
  });
});

// Required scenario 7 -- loading state cannot bypass protection.
//
// HONEST SCOPE: this project has no component-rendering test harness (no
// @testing-library/react), so the actual guard -- OrderList.tsx's own
// `loading` state threaded into ProductAvailabilityCheckModal.tsx as
// `ordersLoading`, which suppresses the confident "safe"/"warning"/"block"
// panel in favor of a neutral "checking" message until OrderList's orders
// subscription has delivered its first snapshot -- cannot be exercised by
// mounting the real component here. What this test DOES prove, at the
// pure-logic level: an empty orders array (exactly what `orders` can still
// be, briefly, before that first snapshot arrives -- this modal's toolbar
// trigger isn't itself gated on `loading`) is INDISTINGUISHABLE, to
// reservationsForLine itself, from "this product genuinely has no
// reservations" -- both produce reservedQty 0 and tier "safe". That is
// precisely why the component-level fix keeps a SEPARATE `ordersLoading`
// boolean rather than trying to infer "still loading" from the reservation
// result: the pure result alone can never tell the two apart, so the loading
// gate cannot be derived from it and must be tracked independently.
describe("loading-state fail-safe (documents why activeOrdersLoaded must be tracked separately from the reservation result)", () => {
  it("an empty/not-yet-loaded orders array produces the exact same 'safe' result as a genuinely unreserved product -- proving the reservation result alone cannot signal 'still loading'", () => {
    const notYetLoaded = reservationsForLine([], TARGET);
    const genuinelyUnreserved = reservationsForLine([order({ lines: [line({ productId: "totally-different" })] })], TARGET);
    expect(notYetLoaded).toEqual(genuinelyUnreserved);
    expect(classifyStoreSaleAvailability(5, notYetLoaded.reservedQty).tier).toBe("safe");
  });
});

// Required scenario 8 -- live order change. ProductAvailabilityCheckModal.tsx
// takes `orders` as a prop straight from OrderList.tsx's own pre-existing
// live ordersApi.subscribe() -- no separate listener of this feature's own.
// HONEST SCOPE: again, no component harness exists to mount either component
// and assert that OrderList's onSnapshot callback firing twice re-renders the
// modal with the new array. What IS verified here is that the pure reducer
// this feature is built on responds correctly to exactly the kind of before/
// after order lists a live onSnapshot delivers across two snapshots (a new
// competing order appearing, or an existing one changing status) -- i.e. the
// logic a live listener feeds is itself correct and has no cached/stale
// state of its own, so once React re-renders OrderList (and therefore this
// modal) with a new `orders` array, this recomputes the right answer, because
// the function has no memory between calls.
describe("live order change (pure-reducer correctness across successive snapshots)", () => {
  it("reflects a newly-arrived competing order the moment it's included -- simulating what a live onSnapshot update delivers", () => {
    const before = reservationsForLine([], TARGET);
    expect(before).toEqual({ reservedQty: 0, entries: [] });

    // A second snapshot delivering a brand-new pending order for this exact
    // product/variant/size, exactly as ordersApi.subscribe()'s callback
    // would receive it.
    const afterNewOrderArrives = reservationsForLine([order({ id: "new-o1", orderNumber: "SIS-999", lines: [line({ qty: 2 })] })], TARGET);
    expect(afterNewOrderArrives.reservedQty).toBe(2);
    // Current stock (2) already nets out this order's claim -- per the
    // corrected formula, "block" only fires once current stock itself hits
    // 0, so a positive current stock with a fresh reservation is "warning":
    // informative, not newly restrictive (see classifyStoreSaleAvailability's
    // own comment for why).
    expect(classifyStoreSaleAvailability(2, afterNewOrderArrives.reservedQty).tier).toBe("warning");
  });

  it("reflects an existing reservation disappearing once that order leaves the reserving-status set -- simulating a live status change (e.g. shipped) removing it from the query's results", () => {
    const whileProcessing = reservationsForLine([order({ id: "o1", status: "processing", lines: [line({ qty: 2 })] })], TARGET);
    expect(whileProcessing.reservedQty).toBe(2);

    // where("status","in",STOCK_RESERVING_ORDER_STATUSES) means a live
    // subscription's next snapshot simply omits this order once its status
    // moves to "shipped" -- reservationsForLine sees an orders array that no
    // longer contains it at all (not a status field it has to check itself).
    const afterShipped = reservationsForLine([], TARGET);
    expect(afterShipped.reservedQty).toBe(0);
    expect(classifyStoreSaleAvailability(2, afterShipped.reservedQty).tier).toBe("safe");
  });
});
