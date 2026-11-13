import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import type { PaymentProvider } from "./types.js";

export type CashfreeCredentials = { appId: string; secretKey: string };

/**
 * Cashfree Payment Gateway (PG API).
 * Docs: https://www.cashfree.com/docs/payments  – verify field names against the API version you enable.
 * Each merchant uses their OWN Cashfree account (Model A), so money settles directly to them.
 */
export class CashfreeProvider implements PaymentProvider {
  readonly name = "cashfree" as const;
  private base: string;
  constructor(private creds: CashfreeCredentials, mode: "sandbox" | "production" = env.CASHFREE_ENV) {
    this.base = mode === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  }

  private async call<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const res = await fetch(this.base + path, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        "x-client-id": this.creds.appId,
        "x-client-secret": this.creds.secretKey,
        "x-api-version": env.CASHFREE_API_VERSION,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AppError(502, "payment_gateway_error", json?.message ?? `Cashfree error ${res.status}`, json);
    return json as T;
  }

  async createOrder(input: Parameters<PaymentProvider["createOrder"]>[0]) {
    const r = await this.call<any>("/orders", {
      method: "POST",
      body: {
        order_id: input.orderId,
        order_amount: input.amountPaise / 100,
        order_currency: "INR",
        customer_details: {
          customer_id: input.customer.id,
          customer_name: input.customer.name,
          customer_phone: input.customer.phone,
          customer_email: input.customer.email,
        },
        order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
      },
    });
    return {
      providerOrderId: r.order_id,
      sessionId: r.payment_session_id,
      checkout: { provider: "cashfree", mode: env.CASHFREE_ENV, paymentSessionId: r.payment_session_id },
    };
  }

  async fetchStatus(providerOrderId: string) {
    const r = await this.call<any>(`/orders/${encodeURIComponent(providerOrderId)}`, { method: "GET" });
    const status = r.order_status === "PAID" ? "paid" : r.order_status === "EXPIRED" || r.order_status === "TERMINATED" ? "failed" : "pending";
    const amountPaise = typeof r.order_amount === "number" ? Math.round(r.order_amount * 100) : undefined;
    return { status: status as "paid" | "pending" | "failed", amountPaise };
  }

  async refund(input: Parameters<PaymentProvider["refund"]>[0]) {
    const r = await this.call<any>(`/orders/${encodeURIComponent(input.providerOrderId)}/refunds`, {
      method: "POST",
      body: { refund_amount: input.amountPaise / 100, refund_id: input.refundId, refund_note: input.reason },
    });
    return { refundId: r.refund_id ?? input.refundId, status: String(r.refund_status ?? "PENDING").toLowerCase() };
  }

  /** Signature = base64(HMAC-SHA256(timestamp + rawBody, secretKey)). */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const sig = String(headers["x-webhook-signature"] ?? headers["x-cashfree-signature"] ?? "");
    const ts = String(headers["x-webhook-timestamp"] ?? headers["x-cashfree-timestamp"] ?? "");
    if (!sig || !ts) return false;
    const expected = crypto.createHmac("sha256", this.creds.secretKey).update(ts + rawBody.toString("utf8")).digest("base64");
    const sigBuf = Buffer.from(sig, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  parseWebhook(body: any) {
    const orderId = body?.data?.order?.order_id;
    if (!orderId) return null;
    const type: string = body?.type ?? "";
    const paymentId = body?.data?.payment?.cf_payment_id ? String(body.data.payment.cf_payment_id) : undefined;
    const status = type.includes("SUCCESS") ? "paid" : type.includes("FAILED") || type.includes("DROPPED") ? "failed" : type.includes("REFUND") ? "refunded" : "pending";
    const paid = body?.data?.payment?.payment_amount;
    const amountPaise = typeof paid === "number" ? Math.round(paid * 100) : undefined;
    return { providerOrderId: orderId, status, paymentId, amountPaise, eventKey: `cashfree:${type}:${orderId}:${paymentId ?? ""}` } as const;
  }
}
