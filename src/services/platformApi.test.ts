import { describe, expect, it } from "vitest";
import { paymentOrder, safePaymentUrl } from "./platformApi";

describe("Sub2API payment normalization", () => {
  it("accepts the live create response and the later order detail", () => {
    const created = paymentOrder({ order_id: 1489, amount: 10, pay_amount: 10, status: "PENDING", qr_code: "fixture-qr", pay_url: "https://pay.example.test/order" });
    expect(created.id).toBe(1489);
    expect(created.payment_url).toBe("https://pay.example.test/order");
    const detail = paymentOrder({ id: 1489, amount: 10, pay_amount: 10, status: "COMPLETED", currency: "CNY" });
    expect({ ...created, ...detail }).toMatchObject({ id: 1489, status: "COMPLETED", qr_code: "fixture-qr", currency: "CNY" });
  });
  it("rejects missing identifiers and malformed replies", () => {
    for (const reply of [null, {}, { order_id: -1 }, { id: 1 }]) expect(() => paymentOrder(reply)).toThrow();
  });
  it("opens only secure payment URLs without embedded credentials", () => {
    expect(safePaymentUrl("https://pay.example.test/order")).toBe("https://pay.example.test/order");
    for (const url of ["javascript:alert(1)", "file:///secret", "http://pay.example.test", "https://user:secret@pay.example.test"]) expect(safePaymentUrl(url)).toBeUndefined();
  });
});
