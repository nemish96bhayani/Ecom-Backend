import { AppError } from "../../lib/errors.js";
import type { ShippingProvider } from "./types.js";

/**
 * Phase 5: Delhivery direct integration for high-volume merchants.
 * The interface is fixed; implement these methods with Delhivery's API once a
 * merchant signs a direct contract. Until then selecting it raises a clear error.
 */
export class DelhiveryProvider implements ShippingProvider {
  readonly name = "delhivery" as const;
  private notReady(): never {
    throw new AppError(501, "not_implemented", "Delhivery direct is planned for Phase 5. Use Shiprocket for now.");
  }
  checkServiceability(): never { return this.notReady(); }
  createShipment(): never { return this.notReady(); }
  track(): never { return this.notReady(); }
  cancel(): never { return this.notReady(); }
  verifyWebhook() { return false; }
  parseWebhook() { return null; }
}
