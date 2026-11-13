import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { redis } from "../../lib/redis.js";
import { normalizeShipStatus, type ShippingProvider, type ShipmentInput } from "./types.js";

export type ShiprocketCredentials = { email: string; password: string; webhookToken: string };

/**
 * Shiprocket external API. Each merchant connects THEIR OWN Shiprocket account
 * (API user created in Shiprocket → Settings → API), so COD remittance goes to them.
 * Docs: https://apidocs.shiprocket.in/
 */
export class ShiprocketProvider implements ShippingProvider {
  readonly name = "shiprocket" as const;
  constructor(private tenantId: string, private creds: ShiprocketCredentials) {}

  private async token(): Promise<string> {
    const key = `shiprocket-token:${this.tenantId}`;
    const hit = await redis.get(key).catch(() => null);
    if (hit) return hit;
    const res = await fetch(`${env.SHIPROCKET_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.creds.email, password: this.creds.password }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.token) throw new AppError(502, "shipping_auth_failed", "Couldn't sign in to Shiprocket. Check the API user email and password.");
    await redis.set(key, json.token, "EX", 60 * 60 * 24 * 9).catch(() => undefined); // tokens last ~10 days
    return json.token;
  }

  private async call<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(env.SHIPROCKET_BASE_URL + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${await this.token()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AppError(502, "shipping_error", json?.message ?? `Shiprocket error ${res.status}`, json);
    return json as T;
  }

  async checkServiceability(i: { pickupPincode: string; deliveryPincode: string; weightKg: number; cod: boolean }) {
    const q = new URLSearchParams({ pickup_postcode: i.pickupPincode, delivery_postcode: i.deliveryPincode, weight: String(i.weightKg), cod: i.cod ? "1" : "0" });
    const r = await this.call<any>(`/courier/serviceability/?${q}`, "GET");
    const list: any[] = r?.data?.available_courier_companies ?? [];
    return {
      serviceable: list.length > 0,
      couriers: list.map((c) => ({ name: c.courier_name, ratePaise: Math.round(Number(c.rate) * 100), etaDays: Number(c.estimated_delivery_days) || undefined, codAvailable: c.cod === 1 })),
    };
  }

  async createShipment(i: ShipmentInput) {
    const [first, ...rest] = i.customer.name.trim().split(" ");
    const order = await this.call<any>("/orders/create/adhoc", "POST", {
      order_id: i.orderNumber,
      order_date: i.orderDate.toISOString().slice(0, 16).replace("T", " "),
      pickup_location: i.pickupLocation,
      billing_customer_name: first,
      billing_last_name: rest.join(" ") || ".",
      billing_address: i.address.line1,
      billing_address_2: i.address.line2 ?? "",
      billing_city: i.address.city,
      billing_pincode: i.address.pincode,
      billing_state: i.address.state,
      billing_country: i.address.country ?? "India",
      billing_email: i.customer.email ?? "",
      billing_phone: i.customer.phone,
      shipping_is_billing: true,
      order_items: i.items.map((it) => ({ name: it.name, sku: it.sku, units: it.units, selling_price: it.sellingPricePaise / 100, hsn: it.hsn ?? "" })),
      payment_method: i.paymentMethod === "cod" ? "COD" : "Prepaid",
      // Shiprocket collects sub_total on COD and we send no separate shipping/COD-fee/discount lines,
      // so this must be the order total the shopper pays (not the merchandise subtotal).
      sub_total: i.totalPaise / 100,
      length: i.dims.l,
      breadth: i.dims.b,
      height: i.dims.h,
      weight: i.weightKg,
    });
    const shipmentId = String(order.shipment_id);
    const awbRes = await this.call<any>("/courier/assign/awb", "POST", { shipment_id: shipmentId });
    const awb = awbRes?.response?.data?.awb_code;
    const courier = awbRes?.response?.data?.courier_name;
    await this.call<any>("/courier/generate/pickup", "POST", { shipment_id: [shipmentId] }).catch(() => undefined);
    const label = await this.call<any>("/courier/generate/label", "POST", { shipment_id: [shipmentId] }).catch(() => ({}));
    return {
      providerOrderId: String(order.order_id),
      shipmentId,
      awb,
      courier,
      labelUrl: label?.label_url,
      trackingUrl: awb ? `https://shiprocket.co/tracking/${awb}` : undefined,
    };
  }

  async track(awb: string) {
    const r = await this.call<any>(`/courier/track/awb/${encodeURIComponent(awb)}`, "GET");
    const td = r?.tracking_data ?? {};
    const status = td?.shipment_track?.[0]?.current_status ?? "UNKNOWN";
    return {
      status,
      normalized: normalizeShipStatus(status),
      events: (td.shipment_track_activities ?? []).map((a: any) => ({ status: a.activity, location: a.location, at: new Date(a.date) })),
    };
  }

  async cancel(providerOrderId: string) {
    await this.call("/orders/cancel", "POST", { ids: [Number(providerOrderId)] });
  }

  /** Shiprocket sends the token you configure in its webhook settings as x-api-key. */
  verifyWebhook(headers: Record<string, string | string[] | undefined>) {
    return !!this.creds.webhookToken && headers["x-api-key"] === this.creds.webhookToken;
  }

  parseWebhook(body: any) {
    if (!body?.awb) return null;
    const status = String(body.current_status ?? body.shipment_status ?? "");
    return { awb: String(body.awb), status, normalized: normalizeShipStatus(status), at: new Date(body.current_timestamp ?? Date.now()), location: body.scans?.[0]?.location };
  }
}
