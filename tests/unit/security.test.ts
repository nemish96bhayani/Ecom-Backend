import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "../../src/lib/crypto.js";
import { CashfreeProvider } from "../../src/integrations/payments/cashfree.js";
import { RazorpayProvider } from "../../src/integrations/payments/razorpay.js";
import { canTransition } from "../../src/services/orders.js";
import { normalizeShipStatus } from "../../src/integrations/shipping/types.js";

describe("credential vault", () => {
  it("round-trips and produces different ciphertext each time", () => {
    const a = encryptSecret("secret-key");
    const b = encryptSecret("secret-key");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("secret-key");
  });
  it("rejects tampered ciphertext", () => {
    const [iv, tag, enc] = encryptSecret("secret-key").split(".");
    const tampered = [iv, tag, Buffer.from("x" + enc).toString("base64")].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("webhook signatures", () => {
  it("accepts a valid Cashfree signature and rejects a forged one", () => {
    const p = new CashfreeProvider({ appId: "app", secretKey: "sk_test" });
    const body = Buffer.from(JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: "o1" } } }));
    const ts = "1700000000";
    const sig = crypto.createHmac("sha256", "sk_test").update(ts + body.toString()).digest("base64");
    expect(p.verifyWebhook(body, { "x-webhook-signature": sig, "x-webhook-timestamp": ts })).toBe(true);
    expect(p.verifyWebhook(body, { "x-webhook-signature": "forged", "x-webhook-timestamp": ts })).toBe(false);
    expect(p.parseWebhook(JSON.parse(body.toString()))?.status).toBe("paid");
  });
  it("accepts a valid Razorpay signature", () => {
    const p = new RazorpayProvider({ keyId: "k", keySecret: "s", webhookSecret: "whsec" });
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
    expect(p.verifyWebhook(body, { "x-razorpay-signature": sig })).toBe(true);
  });
});

describe("order lifecycle", () => {
  it("blocks invalid jumps", () => {
    expect(canTransition("pending_payment", "shipped")).toBe(false);
    expect(canTransition("confirmed", "packed")).toBe(true);
    expect(canTransition("shipped", "rto")).toBe(true);
    expect(canTransition("delivered", "cancelled")).toBe(false);
  });
  it("maps courier statuses", () => {
    expect(normalizeShipStatus("RTO INITIATED")).toBe("rto");
    expect(normalizeShipStatus("DELIVERED")).toBe("delivered");
    expect(normalizeShipStatus("IN TRANSIT")).toBe("in_transit");
  });
});
