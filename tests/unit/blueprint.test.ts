import { describe, it, expect } from "vitest";
import { BLUEPRINTS } from "../../src/services/blueprints.js";
import { MockPaymentProvider } from "../../src/integrations/payments/mock.js";
import { MockShippingProvider } from "../../src/integrations/shipping/mock.js";

describe("Starter Blueprints and Mock Testing Providers", () => {
  it("provides fashion, grocery and general blueprints with complete metadata", () => {
    expect(BLUEPRINTS.fashion).toBeDefined();
    expect(BLUEPRINTS.fashion.title).toContain("Fashion");
    expect(BLUEPRINTS.grocery).toBeDefined();
    expect(BLUEPRINTS.grocery.title).toContain("FMCG");
    expect(BLUEPRINTS.general).toBeDefined();
    expect(BLUEPRINTS.general.title).toContain("Tech");
  });

  it("mock payment provider creates instant testing order and confirms status", async () => {
    const mock = new MockPaymentProvider();
    expect(mock.name).toBe("mock");

    const orderRes = await mock.createOrder({
      orderId: "6724589218d6a80f08960241",
      amountPaise: 249900,
      customer: { id: "cust_123", phone: "9876543210", name: "Test Shopper" },
      returnUrl: "http://localhost:5173/orders/6724589218d6a80f08960241?payment=return",
      notifyUrl: "http://localhost:4000/api/v1/webhooks/payments/mock/tenant_123",
    });

    expect(orderRes.providerOrderId).toContain("mock_order_");
    expect(orderRes.checkout.testMode).toBe(true);

    const statusRes = await mock.fetchStatus(orderRes.providerOrderId);
    expect(statusRes.status).toBe("paid");
  });

  it("mock shipping provider checks serviceability and returns mock AWB", async () => {
    const mock = new MockShippingProvider();
    const serv = await mock.checkServiceability({
      pickupPincode: "395007",
      deliveryPincode: "110001",
      weightKg: 0.5,
      cod: false,
    });

    expect(serv.serviceable).toBe(true);
    expect(serv.couriers.length).toBeGreaterThan(0);

    const shipment = await mock.createShipment({
      orderNumber: "ORD-1001",
      orderDate: new Date(),
      paymentMethod: "online",
      totalPaise: 249900,
      subtotalPaise: 249900,
      customer: { name: "Test Customer", phone: "9876543210" },
      address: { line1: "Test Street", city: "New Delhi", state: "Delhi", pincode: "110001" },
      items: [{ name: "Handcrafted Kurta", sku: "FSH-KRT-M-RED", units: 1, sellingPricePaise: 249900 }],
      weightKg: 0.5,
      dims: { l: 20, b: 15, h: 5 },
      pickupLocation: "Surat Central Warehouse",
    });

    expect(shipment.awb).toMatch(/^MOCK\d+/);
  });
});
