import { Tenant } from "../../models/platform.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { runWithoutTenant } from "../../db/tenantContext.js";
import { ShiprocketProvider, type ShiprocketCredentials } from "./shiprocket.js";
import { DelhiveryProvider } from "./delhivery.js";
import { MockShippingProvider } from "./mock.js";
import type { ShippingProvider } from "./types.js";
import { env } from "../../config/env.js";

export async function getShippingProvider(tenantId: string): Promise<ShippingProvider> {
  const tenant = await runWithoutTenant("load-shipping-credentials", () => Tenant.findById(tenantId).select("+credentials").lean());
  const s = tenant?.credentials?.shipping;
  if (!s?.provider || !s.secret) {
    if (env.NODE_ENV !== "production" || (tenant as any)?.isDemo) {
      return new MockShippingProvider();
    }
    throw new AppError(409, "shipping_not_configured", "Connect a shipping account in Settings → Shipping first");
  }
  if (s.provider === "delhivery") return new DelhiveryProvider();
  if (s.provider === "mock") return new MockShippingProvider();
  return new ShiprocketProvider(tenantId, JSON.parse(decryptSecret(s.secret)) as ShiprocketCredentials);
}

export async function saveShippingConfig(tenantId: string, provider: "shiprocket", credentials: ShiprocketCredentials) {
  await runWithoutTenant("save-shipping-credentials", () =>
    Tenant.updateOne({ _id: tenantId }, { $set: { "credentials.shipping": { provider, secret: encryptSecret(JSON.stringify(credentials)) } } }),
  );
}
