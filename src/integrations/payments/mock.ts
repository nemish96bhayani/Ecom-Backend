import type { PaymentProvider, CreatePaymentInput, CreatePaymentResult, PaymentStatus, WebhookResult } from "./types.js";

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;

  async createOrder(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const mockId = `mock_order_${input.orderId}_${Date.now()}`;
    return {
      providerOrderId: mockId,
      sessionId: `mock_session_${input.orderId}`,
      checkout: {
        provider: "mock",
        orderId: input.orderId,
        amountPaise: input.amountPaise,
        returnUrl: input.returnUrl,
        notifyUrl: input.notifyUrl,
        testMode: true,
      },
    };
  }

  async fetchStatus(providerOrderId: string): Promise<PaymentStatus> {
    return {
      status: "paid",
      paymentId: `mock_pay_${providerOrderId}`,
    };
  }

  async refund(input: { providerOrderId: string; paymentId?: string; amountPaise: number; refundId: string; reason?: string }) {
    return { refundId: input.refundId, status: "SUCCESS" };
  }

  verifyWebhook(_rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): boolean {
    return true;
  }

  parseWebhook(body: any): WebhookResult | null {
    return {
      providerOrderId: body?.orderId ?? body?.providerOrderId ?? "mock_order",
      status: (body?.status as any) ?? "paid",
      paymentId: body?.paymentId ?? `mock_pay_${Date.now()}`,
      eventKey: body?.eventKey ?? "mock.order.paid",
    };
  }
}
