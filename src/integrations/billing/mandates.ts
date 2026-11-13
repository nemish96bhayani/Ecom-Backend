import { env } from "../../config/env.js";

/**
 * Commission auto-debit (UPI AutoPay / e-NACH mandate) — the platform collecting its monthly invoice
 * from the merchant's mandate. The dunning job calls collectStatement() before marking an invoice overdue.
 *
 * MANDATE_PROVIDER=manual (default): nothing is debited automatically; invoices are paid and recorded by
 *   the platform team (Platform → Statements → Mark paid), exactly as today.
 *
 * To automate: implement a provider below against your own gateway's subscription / mandate API
 * (for example Cashfree Subscriptions or Razorpay Subscriptions), store each merchant's mandate id on the
 * tenant during onboarding, and set MANDATE_PROVIDER to its name. Return "collected" only once the gateway
 * confirms the debit; return "failed" on a declined debit so dunning reminders continue.
 */
export type CollectResult =
  { status: "collected"; reference: string } | { status: "failed"; reason: string } | { status: "not_configured" };

export type StatementToCollect = { id: string; tenantId: string; invoiceNumber: string; totalPaise: number };

export async function collectStatement(_s: StatementToCollect): Promise<CollectResult> {
  switch (env.MANDATE_PROVIDER) {
    case "manual":
    default:
      return { status: "not_configured" };
  }
}
