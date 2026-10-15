import { describe, expect, it } from "vitest";
import { buildOrderQrTargetUrl } from "../../src/receipts/renderReceipt";

describe("buildOrderQrTargetUrl", () => {
  it("points at the admin order detail page, not any customer-facing route", () => {
    expect(buildOrderQrTargetUrl("https://sisely.example", "abc123")).toBe("https://sisely.example/admin/orders/abc123");
  });

  it("encodes only the opaque Firestore document id -- no customer name, phone, email, or address", () => {
    const url = buildOrderQrTargetUrl("https://sisely.example", "order-doc-id-xyz");
    expect(url).not.toMatch(/[@]/); // no email-shaped content
    expect(url).toBe("https://sisely.example/admin/orders/order-doc-id-xyz");
  });

  it("uses whatever origin is passed in, so it always matches the app's own deployed domain", () => {
    expect(buildOrderQrTargetUrl("http://localhost:5175", "order1")).toBe("http://localhost:5175/admin/orders/order1");
  });
});
