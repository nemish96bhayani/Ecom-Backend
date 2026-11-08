import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { CashfreeProvider } from "../../src/integrations/payments/cashfree.js";
import { RazorpayProvider } from "../../src/integrations/payments/razorpay.js";

describe("Webhook Signature Verification and Payload Parsing", () => {
  const cashfreeCreds = {
    appId: "TEST_CF_APP_12345",
    secretKey: "test_cf_secret_key_987654321_secure",
  };

  const razorpayCreds = {
    keyId: "rzp_test_1234567890",
    keySecret: "rzp_secret_abcdefghij",
    webhookSecret: "rzp_webhook_secret_xyz123456",
  };

  describe("Cashfree Webhook Verification", () => {
    const cf = new CashfreeProvider(cashfreeCreds, "sandbox");

    it("verifies authentic Cashfree webhook with valid HMAC-SHA256 signature", () => {
      const payload = JSON.stringify({
        data: {
          order: { order_id: "ORD-9901" },
          payment: { cf_payment_id: "CF_PAY_8899" },
        },
        type: "PAYMENT_SUCCESS_WEBHOOK",
      });
      const rawBody = Buffer.from(payload, "utf8");
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto
        .createHmac("sha256", cashfreeCreds.secretKey)
        .update(ts + rawBody.toString("utf8"))
        .digest("base64");

      const headers = {
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      };

      expect(cf.verifyWebhook(rawBody, headers)).toBe(true);

      const parsed = cf.parseWebhook(JSON.parse(payload));
      expect(parsed).toBeDefined();
      expect(parsed?.status).toBe("paid");
      expect(parsed?.providerOrderId).toBe("ORD-9901");
      expect(parsed?.paymentId).toBe("CF_PAY_8899");
    });

    it("accepts x-cashfree-signature header variant", () => {
      const payload = JSON.stringify({ data: { order: { order_id: "ORD-9902" } }, type: "PAYMENT_FAILED_WEBHOOK" });
      const rawBody = Buffer.from(payload, "utf8");
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac("sha256", cashfreeCreds.secretKey).update(ts + rawBody.toString("utf8")).digest("base64");

      const headers = {
        "x-cashfree-signature": sig,
        "x-cashfree-timestamp": ts,
      };

      expect(cf.verifyWebhook(rawBody, headers)).toBe(true);
      const parsed = cf.parseWebhook(JSON.parse(payload));
      expect(parsed?.status).toBe("failed");
    });

    it("rejects tampered body or invalid signature without throwing", () => {
      const payload = JSON.stringify({ data: { order: { order_id: "ORD-HACK" } } });
      const rawBody = Buffer.from(payload, "utf8");
      const headers = {
        "x-webhook-signature": "tampered_invalid_signature_base64",
        "x-webhook-timestamp": "1730000000",
      };

      expect(cf.verifyWebhook(rawBody, headers)).toBe(false);
    });

    it("rejects webhook when timestamp or signature is missing", () => {
      const rawBody = Buffer.from("{}", "utf8");
      expect(cf.verifyWebhook(rawBody, {})).toBe(false);
      expect(cf.verifyWebhook(rawBody, { "x-webhook-timestamp": "123" })).toBe(false);
    });
  });

  describe("Razorpay Webhook Verification", () => {
    const rz = new RazorpayProvider(razorpayCreds);

    it("verifies authentic Razorpay webhook with valid hex HMAC-SHA256 signature", () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_RZP12345", order_id: "order_RZP98765" },
          },
        },
      });
      const rawBody = Buffer.from(payload, "utf8");
      const sig = crypto
        .createHmac("sha256", razorpayCreds.webhookSecret)
        .update(rawBody)
        .digest("hex");

      const headers = {
        "x-razorpay-signature": sig,
      };

      expect(rz.verifyWebhook(rawBody, headers)).toBe(true);

      const parsed = rz.parseWebhook(JSON.parse(payload));
      expect(parsed).toBeDefined();
      expect(parsed?.status).toBe("paid");
      expect(parsed?.providerOrderId).toBe("order_RZP98765");
      expect(parsed?.paymentId).toBe("pay_RZP12345");
    });

    it("rejects Razorpay webhook with wrong secret or tampered body", () => {
      const payload = JSON.stringify({ event: "payment.captured" });
      const rawBody = Buffer.from(payload, "utf8");
      const wrongSig = crypto
        .createHmac("sha256", "wrong_attacker_secret")
        .update(rawBody)
        .digest("hex");

      expect(rz.verifyWebhook(rawBody, { "x-razorpay-signature": wrongSig })).toBe(false);
      expect(rz.verifyWebhook(rawBody, { "x-razorpay-signature": "short_sig" })).toBe(false);
      expect(rz.verifyWebhook(rawBody, {})).toBe(false);
    });

    it("parses refund events accurately", () => {
      const payload = {
        event: "refund.processed",
        payload: {
          payment: { entity: { id: "pay_11", order_id: "order_11" } },
        },
      };
      const parsed = rz.parseWebhook(payload);
      expect(parsed?.status).toBe("refunded");
      expect(parsed?.providerOrderId).toBe("order_11");
    });
  });
});
