import type { ShippingProvider, ShipmentInput, ShipmentResult, NormalizedShipStatus } from "./types.js";

export class MockShippingProvider implements ShippingProvider {
  readonly name = "mock" as any;

  async checkServiceability(_input: { pickupPincode: string; deliveryPincode: string; weightKg: number; cod: boolean }) {
    return {
      serviceable: true,
      couriers: [
        { name: "BlueDart Express (Sandbox)", ratePaise: 4900, etaDays: 2, codAvailable: true },
        { name: "Delhivery Surface (Sandbox)", ratePaise: 3900, etaDays: 4, codAvailable: true },
      ],
    };
  }

  async createShipment(input: ShipmentInput): Promise<ShipmentResult> {
    const awb = `MOCK${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    const id = `mock_ship_${Date.now()}`;
    return {
      providerOrderId: id,
      shipmentId: id,
      awb,
      courier: "Express Courier (Sandbox)",
      labelUrl: undefined, // Generated locally via /api/v1/admin/orders/:id/label.pdf
      trackingUrl: undefined,
    };
  }

  async track(awb: string): Promise<{ status: string; normalized: NormalizedShipStatus; events: { status: string; location?: string; at: Date }[] }> {
    return {
      status: "IN_TRANSIT",
      normalized: "in_transit",
      events: [
        { status: "Shipment manifested", location: "Surat Hub", at: new Date(Date.now() - 86400000) },
        { status: "In transit to destination hub", location: "Mumbai Air Hub", at: new Date() },
      ],
    };
  }

  async cancel(_providerOrderId: string): Promise<void> {}

  verifyWebhook(_headers: Record<string, string | string[] | undefined>): boolean {
    return true;
  }

  parseWebhook(body: any): { awb: string; status: string; normalized: NormalizedShipStatus; at: Date; location?: string } | null {
    return {
      awb: body?.awb ?? "MOCK1234567890",
      status: "DELIVERED",
      normalized: "delivered",
      at: new Date(),
      location: body?.location ?? "Customer Doorstep",
    };
  }
}
