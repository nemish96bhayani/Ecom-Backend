export type PaymentCustomer = { id: string; name?: string; phone: string; email?: string };

export type CreatePaymentInput = {
  orderId: string; // our order id – used as the gateway order reference
  amountPaise: number;
  customer: PaymentCustomer;
  returnUrl: string;
  notifyUrl: string;
};

export type CreatePaymentResult = {
  providerOrderId: string;
  sessionId?: string;
  /** Everything the storefront needs to open the gateway's checkout. */
  checkout: Record<string, unknown>;
};

/** amountPaise is what the gateway says was paid; used to refuse confirming an underpaid order. */
export type PaymentStatus = { status: "paid" | "pending" | "failed"; paymentId?: string; amountPaise?: number };

export type WebhookResult = { providerOrderId: string; status: "paid" | "failed" | "pending" | "refunded"; paymentId?: string; eventKey: string; amountPaise?: number };

export interface PaymentProvider {
  readonly name: "cashfree" | "razorpay" | "mock";
  createOrder(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  fetchStatus(providerOrderId: string): Promise<PaymentStatus>;
  refund(input: { providerOrderId: string; paymentId?: string; amountPaise: number; refundId: string; reason?: string }): Promise<{ refundId: string; status: string }>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(body: any): WebhookResult | null;
}
