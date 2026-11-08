export type ShipmentInput = {
  orderNumber: string;
  orderDate: Date;
  paymentMethod: "online" | "cod";
  totalPaise: number;
  subtotalPaise: number;
  customer: { name: string; phone: string; email?: string };
  address: { line1: string; line2?: string; city: string; state: string; pincode: string; country?: string };
  items: { name: string; sku: string; units: number; sellingPricePaise: number; hsn?: string }[];
  weightKg: number;
  dims: { l: number; b: number; h: number };
  pickupLocation: string;
};

export type ShipmentResult = {
  providerOrderId: string;
  shipmentId: string;
  awb?: string;
  courier?: string;
  labelUrl?: string;
  trackingUrl?: string;
};

export type NormalizedShipStatus = "shipped" | "delivered" | "rto" | "cancelled" | "in_transit" | "unknown";

export interface ShippingProvider {
  readonly name: "shiprocket" | "delhivery";
  checkServiceability(input: { pickupPincode: string; deliveryPincode: string; weightKg: number; cod: boolean }): Promise<{
    serviceable: boolean;
    couriers: { name: string; ratePaise: number; etaDays?: number; codAvailable: boolean }[];
  }>;
  createShipment(input: ShipmentInput): Promise<ShipmentResult>;
  track(awb: string): Promise<{ status: string; normalized: NormalizedShipStatus; events: { status: string; location?: string; at: Date }[] }>;
  cancel(providerOrderId: string): Promise<void>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(body: any): { awb: string; status: string; normalized: NormalizedShipStatus; at: Date; location?: string } | null;
}

export function normalizeShipStatus(raw: string): NormalizedShipStatus {
  const s = raw.toUpperCase();
  if (s.includes("RTO")) return "rto";
  if (s === "DELIVERED") return "delivered";
  if (s.includes("CANCEL")) return "cancelled";
  if (s.includes("PICKED") || s.includes("SHIPPED")) return "shipped";
  if (s.includes("TRANSIT") || s.includes("OUT FOR DELIVERY") || s.includes("REACHED")) return "in_transit";
  return "unknown";
}
