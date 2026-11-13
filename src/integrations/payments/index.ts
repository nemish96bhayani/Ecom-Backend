import { Tenant } from "../../models/platform.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { runWithoutTenant } from "../../db/tenantContext.js";
import { CashfreeProvider, type CashfreeCredentials } from "./cashfree.js";
import { RazorpayProvider, type RazorpayCredentials } from "./razorpay.js";
import { MockPaymentProvider } from "./mock.js";
import type { PaymentProvider } from "./types.js";
import { env } from "../../config/env.js";

export type PaymentConfig =
  | { provider: "cashfree"; mode: "sandbox" | "production"; credentials: CashfreeCredentials }
  | { provider: "razorpay"; mode: "sandbox" | "production"; credentials: RazorpayCredentials }
  | { provider: "mock"; mode: "sandbox" | "production"; credentials: Record<string, unknown> };

/** Loads the tenant's own gateway credentials from the encrypted vault. */
export async function getPaymentProvider(tenantId: string): Promise<PaymentProvider> {
  const tenant = await runWithoutTenant("load-payment-credentials", () => Tenant.findById(tenantId).select("+credentials").lean());
  const p = tenant?.credentials?.payment;
  if (!p?.provider || !p.secret) {
    if (env.NODE_ENV !== "production" || (tenant as any)?.isDemo) {
      return new MockPaymentProvider();
    }
    throw new AppError(409, "payments_not_configured", "Online payments are not set up for this store yet");
  }
  const creds = JSON.parse(decryptSecret(p.secret));
  if (p.provider === "mock") {
    // The test gateway confirms every payment, so it must never serve a live store.
    if (env.NODE_ENV === "production" && !(tenant as any)?.isDemo) {
      throw new AppError(409, "payments_not_configured", "Online payments are not set up for this store yet");
    }
    return new MockPaymentProvider();
  }
  if (p.provider === "cashfree") return new CashfreeProvider(creds, (p.mode as any) ?? "sandbox");
  return new RazorpayProvider(creds);
}

export async function savePaymentConfig(tenantId: string, cfg: PaymentConfig) {
  if (cfg.provider === "mock" && env.NODE_ENV === "production") {
    throw new AppError(400, "mock_not_allowed", "The test payment gateway can't be used in production");
  }
  await runWithoutTenant("save-payment-credentials", () =>
    Tenant.updateOne(
      { _id: tenantId },
      { $set: { "credentials.payment": { provider: cfg.provider, mode: cfg.mode, secret: encryptSecret(JSON.stringify(cfg.credentials)) } } },
    ),
  );
}
