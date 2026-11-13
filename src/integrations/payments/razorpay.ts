import crypto from "node:crypto";
import { AppError } from "../../lib/errors.js";
import type { PaymentProvider } from "./types.js";

export type RazorpayCredentials = { keyId: string; keySecret: string; webhookSecret: string };

/** Razorpay Standard Checkout – alternative gateway a merchant can choose instead of Cashfree. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay" as const;
  private base = "https://api.razorpay.com/v1";
  constructor(private creds: RazorpayCredentials) {}

  private async call<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + Buffer.from(`${this.creds.keyId}:${this.creds.keySecret}`).toString("base64"),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AppError(502, "payment_gateway_error", json?.error?.description ?? `Razorpay error ${res.status}`, json);
    return json as T;
  }

  async createOrder(input: Parameters<PaymentProvider["createOrder"]>[0]) {
    const r = await this.call<any>("/orders", "POST", { amount: input.amountPaise, currency: "INR", receipt: input.orderId, notes: { orderId: input.orderId } });
    return {
      providerOrderId: r.id,
      checkout: { provider: "razorpay", keyId: this.creds.keyId, orderId: r.id, amount: input.amountPaise, prefill: { name: input.customer.name, contact: input.customer.phone, email: input.customer.email } },
    };
  }

  async fetchStatus(providerOrderId: string) {
    const r = await this.call<any>(`/orders/${providerOrderId}/payments`, "GET");
    const captured = (r.items ?? []).find((p: any) => p.status === "captured");
    if (captured) return { status: "paid" as const, paymentId: captured.id, amountPaise: typeof captured.amount === "number" ? captured.amount : undefined };
    const failed = (r.items ?? []).length > 0 && (r.items ?? []).every((p: any) => p.status === "failed");
    return { status: failed ? ("failed" as const) : ("pending" as const) };
  }

  async refund(input: Parameters<PaymentProvider["refund"]>[0]) {
    if (!input.paymentId) throw new AppError(400, "missing_payment", "Payment id is required for Razorpay refunds");
    const r = await this.call<any>(`/payments/${input.paymentId}/refund`, "POST", { amount: input.amountPaise, receipt: input.refundId, notes: { reason: input.reason ?? "" } });
    return { refundId: r.id, status: r.status };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const sig = String(headers["x-razorpay-signature"] ?? "");
    if (!sig) return false;
    const expected = crypto.createHmac("sha256", this.creds.webhookSecret).update(rawBody).digest("hex");
    const sigBuf = Buffer.from(sig, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  /** Verifies the signature returned to the browser after checkout (order_id|payment_id). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string) {
    const expected = crypto.createHmac("sha256", this.creds.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
    return expected === signature;
  }

  parseWebhook(body: any) {
    const p = body?.payload?.payment?.entity;
    const orderId = p?.order_id ?? body?.payload?.order?.entity?.id;
    if (!orderId) return null;
    const ev: string = body.event ?? "";
    const status = ev === "payment.captured" || ev === "order.paid" ? "paid" : ev === "payment.failed" ? "failed" : ev.startsWith("refund") ? "refunded" : "pending";
    return { providerOrderId: orderId, status, paymentId: p?.id, amountPaise: typeof p?.amount === "number" ? p.amount : undefined, eventKey: `razorpay:${ev}:${p?.id ?? orderId}` } as const;
  }
}
